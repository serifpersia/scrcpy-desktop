const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { log } = require('./logger');
const C = require('./constants');
const adbService = require('./adbService');

const nativeModule = require('./native/build/Release/scrcpy_native');

const parseSPS = nativeModule.parseSPS;
const parseAudioSpecificConfig = nativeModule.parseAudioSpecificConfig;

const sessions = new Map();
const workers = new Map();

function _handleAwaitingInitialData(socket, dynBuffer, session, client) {
    if (!session.deviceNameReceived) {
        if (dynBuffer.length >= C.DEVICE_NAME_LENGTH) {
            const deviceName = dynBuffer.buffer.subarray(0, C.DEVICE_NAME_LENGTH).toString('utf8').split('\0')[0];
            client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.DEVICE_NAME, name: deviceName }));
            dynBuffer.buffer.copy(dynBuffer.buffer, 0, C.DEVICE_NAME_LENGTH, dynBuffer.length);
            dynBuffer.length -= C.DEVICE_NAME_LENGTH;
            session.deviceNameReceived = true; socket.didHandleDeviceName = true;
            socket.state = 'AWAITING_METADATA';
            attemptIdentifyControlByDeduction(session, client);
            return true;
        }
    } else { socket.state = 'AWAITING_METADATA'; return true; }
    return false;
}

function _handleAwaitingMetadata(socket, dynBuffer, session, client) {
    let identifiedThisPass = false;
    if (!session.videoSocket && session.expectedSockets.includes('video')) {
        if (dynBuffer.length >= C.VIDEO_METADATA_LENGTH_H264) { 
            const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
            if (potentialCodecId === C.CODEC_IDS.H264) {
                const width = dynBuffer.buffer.readUInt32BE(4); const height = dynBuffer.buffer.readUInt32BE(8);
                log(C.LogLevel.INFO, `[Session ${session.scid}] Identified Video socket (${width}x${height}) for ${session.decoderType}`);
                session.videoSocket = socket; socket.type = 'video'; identifiedThisPass = true;
                session.unidentifiedSockets?.delete(socket.remoteId);
                session.currentWidth = width; session.currentHeight = height;
                client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.VIDEO_INFO, codecId: potentialCodecId, width, height }));
                dynBuffer.buffer.copy(dynBuffer.buffer, 0, C.VIDEO_METADATA_LENGTH_H264, dynBuffer.length);
                dynBuffer.length -= C.VIDEO_METADATA_LENGTH_H264; socket.state = 'STREAMING';
                checkAndSendStreamingStarted(session, client);
            }}}
    if (!identifiedThisPass && !session.audioSocket && session.expectedSockets.includes('audio')) {
        if (dynBuffer.length >= C.AUDIO_METADATA_LENGTH_AAC) {
            const potentialCodecId = dynBuffer.buffer.readUInt32BE(0);
            if (potentialCodecId === C.CODEC_IDS.AAC) {
                log(C.LogLevel.INFO, `[Session ${session.scid}] Identified Audio socket`);
                session.audioSocket = socket; socket.type = 'audio'; socket.codecProcessed = true; identifiedThisPass = true;
                session.unidentifiedSockets?.delete(socket.remoteId);
                client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.AUDIO_INFO, codecId: potentialCodecId }));
                dynBuffer.buffer.copy(dynBuffer.buffer, 0, C.AUDIO_METADATA_LENGTH_AAC, dynBuffer.length);
                dynBuffer.length -= C.AUDIO_METADATA_LENGTH_AAC; socket.state = 'STREAMING';
                checkAndSendStreamingStarted(session, client);
            }}}
    if (!identifiedThisPass && !session.controlSocket && session.expectedSockets.length === 1 && session.expectedSockets[0] === 'control' && socket.didHandleDeviceName) {
        log(C.LogLevel.INFO, `[Session ${session.scid}] Identified Control socket (only expected stream)`);
        session.controlSocket = socket; socket.type = 'control'; identifiedThisPass = true;
        session.unidentifiedSockets?.delete(socket.remoteId); socket.state = 'STREAMING';
        const worker = new Worker(path.resolve(__dirname, 'controlWorker.js'), { workerData: { scid: session.scid, clientId: session.clientId, CURRENT_LOG_LEVEL: C.CURRENT_LOG_LEVEL }});
        workers.set(session.scid, worker);
        worker.on('message', (msg) => {
            if (msg.type === 'writeToSocket') {
                const currentSession = sessions.get(msg.scid);
                if (currentSession?.controlSocket && !currentSession.controlSocket.destroyed) {
                    try { currentSession.controlSocket.write(Buffer.from(msg.data.data ? msg.data.data : msg.data)); }
                    catch (e) {
                        const currentClient = client.wsClientsRef?.get(currentSession.clientId);
                        if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, scid: msg.scid, message: `Control error: ${e.message}`}));
                    }}}});
        worker.on('error', (err) => { log(C.LogLevel.ERROR, `[Worker ${session.scid}] Error: ${err.message}`); workers.delete(session.scid); });
        worker.on('exit', (code) => { log(C.LogLevel.INFO, `[Worker ${session.scid}] Exited with code ${code}`); workers.delete(session.scid); });
        checkAndSendStreamingStarted(session, client);
    }
    if (identifiedThisPass) { attemptIdentifyControlByDeduction(session, client); return true; }
    else {
        attemptIdentifyControlByDeduction(session, client);
        if (!session.controlSocket && session.expectedSockets.includes('control') && session.unidentifiedSockets?.has(socket.remoteId)) return false;
        return dynBuffer.length > 0;
    }
}

const extractNaluPayload = nativeModule.extractNaluPayload;
const extractSingleNalu = nativeModule.extractSingleNalu;


const createAVCC = nativeModule.createAVCC;

const START_CODE_3 = Buffer.from([0, 0, 1]);
const START_CODE_4 = Buffer.from([0, 0, 0, 1]);

const annexBToLengthPrefixed = nativeModule.annexBToLengthPrefixed;

function _processVideoStreamPacket(socket, dynBuffer, session, client) {
    if (dynBuffer.length >= C.PACKET_HEADER_LENGTH) {
        const firstByte = dynBuffer.buffer.readUInt8(0);
        const configFlagInt = (firstByte >> 7) & 0x1;
        const keyFrameFlagInt = (firstByte >> 6) & 0x1;
        const pts = dynBuffer.buffer.readBigInt64BE(0) & BigInt('0x3FFFFFFFFFFFFFFF');
        const packetSize = dynBuffer.buffer.readUInt32BE(8);

        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) { log(C.LogLevel.ERROR, `[TCP Video ${socket.scid}] Invalid packet size: ${packetSize}`); socket.state = 'UNKNOWN'; socket.destroy(); return false; }
        const totalPacketLength = C.PACKET_HEADER_LENGTH + packetSize;

        if (dynBuffer.length >= totalPacketLength) {
            const payload = dynBuffer.buffer.subarray(C.PACKET_HEADER_LENGTH, totalPacketLength);
            
            if (session.decoderType === 'webcodecs') {
                let packetType;
                if (configFlagInt) {
                    log(C.LogLevel.DEBUG, `[TCP Video ${socket.scid}] Received config packet for WebCodecs. Payload length: ${payload.length}`);
                    packetType = C.BINARY_PACKET_TYPES.WC_VIDEO_CONFIG_H264;
                    
                    const spsNaluWithStartCode = extractSingleNalu(payload, 7); 
                    const ppsNaluWithStartCode = extractSingleNalu(payload, 8); 

                    if (spsNaluWithStartCode && ppsNaluWithStartCode) {
                        log(C.LogLevel.DEBUG, `[TCP Video ${socket.scid}] Extracted SPS (len ${spsNaluWithStartCode.length}) and PPS (len ${ppsNaluWithStartCode.length}) from config payload.`);
                        const avcc = createAVCC(spsNaluWithStartCode, ppsNaluWithStartCode);
                        const spsData = parseSPS(spsNaluWithStartCode);

                        if (avcc && spsData) {
                            const header = Buffer.alloc(1 + 3); 
                            header.writeUInt8(packetType, 0);
                            header.writeUInt8(spsData.profile_idc, 1);
                            header.writeUInt8(spsData.profile_compatibility, 2);
                            header.writeUInt8(spsData.level_idc, 3);

                            client.ws.send(Buffer.concat([header, avcc]), { binary: true });
                            log(C.LogLevel.INFO, `[TCP Video ${socket.scid}] Sent AVCC config (len ${avcc.length}) with SPS info to client.`);
                        } else {
                             log(C.LogLevel.WARN, `[TCP Video ${socket.scid}] Failed to create AVCC or parse SPS from extracted NALUs. AVCC: ${!!avcc}, SPSData: ${!!spsData}`);
                        }
                        if (spsData) { 
                            const newWidth = spsData.width, newHeight = spsData.height;
                            if (session.currentWidth !== newWidth || session.currentHeight !== newHeight) {
                                log(C.LogLevel.INFO, `[TCP Video ${socket.scid}] Resolution change from config: ${newWidth}x${newHeight}`);
                                session.currentWidth = newWidth; session.currentHeight = newHeight;
                                if (client && client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.RESOLUTION_CHANGE, width: newWidth, height: newHeight }));
                            }
                        }
                    } else {
                        log(C.LogLevel.WARN, `[TCP Video ${socket.scid}] Could not extract SPS/PPS from config packet payload. SPS: ${!!spsNaluWithStartCode}, PPS: ${!!ppsNaluWithStartCode}. Config Payload length: ${payload.length}`);
                    }
                } else {
                    packetType = keyFrameFlagInt ? C.BINARY_PACKET_TYPES.WC_VIDEO_KEY_FRAME_H264 : C.BINARY_PACKET_TYPES.WC_VIDEO_DELTA_FRAME_H264;
                    const header = Buffer.alloc(1 + 8);
                    header.writeUInt8(packetType, 0);
                    header.writeBigUInt64BE(pts, 1);
                    const lengthPrefixedPayload = annexBToLengthPrefixed(payload);
                    const frameBuffer = Buffer.alloc(header.length + lengthPrefixedPayload.length);
                    header.copy(frameBuffer);
                    lengthPrefixedPayload.copy(frameBuffer, header.length);
                    client.ws.send(frameBuffer, { binary: true });
                }
            } else { 
                if (configFlagInt) {
                     const spsNaluFromLegacy = extractSingleNalu(payload, 7);
                     if (spsNaluFromLegacy) {
                        const resolutionInfo = parseSPS(spsNaluFromLegacy);
                        if (resolutionInfo) {
                            const newWidth = resolutionInfo.width, newHeight = resolutionInfo.height;
                            if (session.currentWidth !== newWidth || session.currentHeight !== newHeight) {
                                session.currentWidth = newWidth; session.currentHeight = newHeight;
                                if (client && client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.RESOLUTION_CHANGE, width: newWidth, height: newHeight }));
                            }
                        }
                     }
                }
                const typeBuffer = Buffer.alloc(1); typeBuffer.writeUInt8(C.BINARY_PACKET_TYPES.LEGACY_VIDEO_H264, 0);
                const frameBuffer = Buffer.alloc(typeBuffer.length + payload.length);
                typeBuffer.copy(frameBuffer);
                payload.copy(frameBuffer, typeBuffer.length);
                client.ws.send(frameBuffer, { binary: true });
            }

            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
            dynBuffer.length -= totalPacketLength; return true;
        }}
    return false;
}

function _processAudioStreamPacket(socket, dynBuffer, session, client) {
    if (dynBuffer.length >= C.PACKET_HEADER_LENGTH) {
        const firstByte = dynBuffer.buffer.readUInt8(0);
        const configFlagInt = (firstByte >> 7) & 0x1;
        const pts = dynBuffer.buffer.readBigInt64BE(0) & BigInt('0x3FFFFFFFFFFFFFFF');
        const packetSize = dynBuffer.buffer.readUInt32BE(8);

        if (packetSize > 10 * 1024 * 1024 || packetSize < 0) { log(C.LogLevel.ERROR, `[TCP Audio ${socket.scid}] Invalid packet size: ${packetSize}`); socket.state = 'UNKNOWN'; socket.destroy(); return false; }
        const totalPacketLength = C.PACKET_HEADER_LENGTH + packetSize;

        if (dynBuffer.length >= totalPacketLength) {
            const payload = dynBuffer.buffer.subarray(C.PACKET_HEADER_LENGTH, totalPacketLength);
            
            if (configFlagInt) {
                try {
                    session.audioMetadata = parseAudioSpecificConfig(payload);
                    if (session.audioMetadata && session.audioMetadata.rawASC) {
                        const header = Buffer.alloc(1);
                        header.writeUInt8(C.BINARY_PACKET_TYPES.WC_AUDIO_CONFIG_AAC, 0);
                        const configBuffer = Buffer.alloc(header.length + session.audioMetadata.rawASC.length);
                        header.copy(configBuffer);
                        session.audioMetadata.rawASC.copy(configBuffer, header.length);
                        client.ws.send(configBuffer, { binary: true });
                        log(C.LogLevel.DEBUG, `[TCP Audio ${socket.scid}] Sent ASC config to client.`);
                    } else {
                         log(C.LogLevel.ERROR, `[TCP Audio ${socket.scid}] Failed to get raw ASC from audio config.`);
                    }
                } catch (e) { log(C.LogLevel.ERROR, `[TCP Audio ${socket.scid}] Failed to parse audio config: ${e.message}`); socket.destroy(); return false; }
            } else if (session.audioMetadata) { 
                const header = Buffer.alloc(1 + 8);
                header.writeUInt8(C.BINARY_PACKET_TYPES.WC_AUDIO_FRAME_AAC, 0);
                header.writeBigUInt64BE(pts, 1);
                const frameBuffer = Buffer.alloc(header.length + payload.length);
                header.copy(frameBuffer);
                payload.copy(frameBuffer, header.length);
                client.ws.send(frameBuffer, { binary: true });
            }


            dynBuffer.buffer.copy(dynBuffer.buffer, 0, totalPacketLength, dynBuffer.length);
            dynBuffer.length -= totalPacketLength; return true;
        }}
    return false;
}


function _processControlStreamMessage(socket, dynBuffer, session, client) {
    if (dynBuffer.length > 0) {
        client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.DEVICE_MESSAGE, data: dynBuffer.buffer.subarray(0, dynBuffer.length).toString('base64') }));
        dynBuffer.length = 0;
    }
    return false; 
}


function _handleStreamingData(socket, dynBuffer, session, client) {
    if (!socket.type || socket.type === 'unknown') { socket.state = 'AWAITING_METADATA'; return true; }
    let processedPacket = false;
    if (socket.type === 'video') processedPacket = _processVideoStreamPacket(socket, dynBuffer, session, client);
    else if (socket.type === 'audio') processedPacket = _processAudioStreamPacket(socket, dynBuffer, session, client);
    else if (socket.type === 'control') processedPacket = _processControlStreamMessage(socket, dynBuffer, session, client);
    return processedPacket;
}

function processSingleSocket(socket, client, session) {
    const dynBuffer = socket.dynamicBuffer;
    if (!socket.codecProcessed) socket.codecProcessed = false;
    let keepProcessing = true;
    while (keepProcessing && !socket.destroyed && socket.state !== 'UNKNOWN') {
        keepProcessing = false;
        switch (socket.state) {
            case 'AWAITING_INITIAL_DATA': if (_handleAwaitingInitialData(socket, dynBuffer, session, client)) keepProcessing = true; break;
            case 'AWAITING_METADATA': if (_handleAwaitingMetadata(socket, dynBuffer, session, client)) keepProcessing = true; break;
            case 'STREAMING': if (_handleStreamingData(socket, dynBuffer, session, client)) keepProcessing = true; break;
            default: socket.state = 'UNKNOWN'; log(C.LogLevel.ERROR, `[TCP] Socket ${socket.scid} from ${socket.remoteId} invalid state: ${socket.state}.`); break;
        }
    }
}

function createTcpServer(scid, wsClientsRef) {
    const server = net.createServer((socket) => {
        const remoteId = `${socket.remoteAddress}:${socket.remotePort}`;
        const session = sessions.get(scid);
        if (!session) { socket.destroy(); return; }
        if (session.socketsConnected >= session.expectedSockets.length) { socket.destroy(); return; }
        session.socketsConnected++;
		socket.setNoDelay(true);
        socket.scid = scid; socket.remoteId = remoteId;
        socket.dynamicBuffer = { buffer: Buffer.alloc(1024 * 512), length: 0 };
        socket.state = 'AWAITING_INITIAL_DATA'; socket.type = 'unknown'; socket.didHandleDeviceName = false;
        session.unidentifiedSockets.set(remoteId, socket);
        log(C.LogLevel.DEBUG, `[TCP] Socket connected for ${scid} from ${remoteId}. Total: ${session.socketsConnected}/${session.expectedSockets.length}`);
        socket.on('data', (data) => {
            const currentSession = sessions.get(scid);
            if (!currentSession) { socket.destroy(); return; }
            const currentClient = wsClientsRef.get(currentSession.clientId);
            if (!currentClient || currentClient.ws?.readyState !== WebSocket.OPEN) { if (!socket.destroyed) socket.destroy(); return; }
            const dynBuf = socket.dynamicBuffer; const requiredLength = dynBuf.length + data.length;
            if (requiredLength > dynBuf.buffer.length) {
                const newSize = Math.max(dynBuf.buffer.length * 2, requiredLength + 1024);
                try { const newBuffer = Buffer.allocUnsafe(newSize); dynBuf.buffer.copy(newBuffer, 0, 0, dynBuf.length); dynBuf.buffer = newBuffer; }
                catch (e) { log(C.LogLevel.ERROR, `[TCP] Buffer alloc fail ${socket.scid}: ${e.message}`); socket.destroy(); cleanupSession(socket.scid, wsClientsRef); return; }
            }
            data.copy(dynBuf.buffer, dynBuf.length); dynBuf.length += data.length;
            processSingleSocket(socket, currentClient, currentSession);
            if (dynBuf.length === 0 && dynBuf.buffer.length > 1024 * 512) try { dynBuf.buffer = Buffer.alloc(1024 * 512); } catch (e) {}
        });
        socket.on('end', () => { log(C.LogLevel.DEBUG, `[TCP] Socket ended ${scid} from ${remoteId}`); clearSocketReference(scid, socket, wsClientsRef); sessions.get(scid)?.unidentifiedSockets?.delete(remoteId); });
        socket.on('close', (hadError) => { log(C.LogLevel.DEBUG, `[TCP] Socket closed ${scid} from ${remoteId}. Error: ${hadError}`); clearSocketReference(scid, socket, wsClientsRef); sessions.get(scid)?.unidentifiedSockets?.delete(remoteId); });
        socket.on('error', (err) => { log(C.LogLevel.ERROR, `[TCP] Socket error ${scid} from ${remoteId}: ${err.message}`); clearSocketReference(scid, socket, wsClientsRef); sessions.get(scid)?.unidentifiedSockets?.delete(remoteId); socket.destroy(); });
        const client = session ? wsClientsRef.get(session.clientId) : null;
        if (client && client.ws?.readyState === WebSocket.OPEN) processSingleSocket(socket, client, session);
        else { socket.destroy(); }
    });
    server.on('error', (err) => { log(C.LogLevel.ERROR, `[TCP] Server error for ${scid}: ${err.message}`); cleanupSession(scid, wsClientsRef); });
    return server;
}

function clearSocketReference(scid, socket, wsClientsRef) {
    const session = sessions.get(scid); if (!session) return;
    if (session.videoSocket === socket) session.videoSocket = null;
    else if (session.audioSocket === socket) session.audioSocket = null;
    else if (session.controlSocket === socket) session.controlSocket = null;
    const allSocketsClosed = !session.videoSocket && !session.audioSocket && !session.controlSocket;
    const expectedSocketsMet = session.socketsConnected >= session.expectedSockets.length;
    if (expectedSocketsMet && allSocketsClosed) {
        log(C.LogLevel.INFO, `[Session ${scid}] All expected sockets closed. Triggering cleanup.`);
        cleanupSession(scid, wsClientsRef);
    }
}

async function checkAndSendStreamingStarted(session, client) {
    if (!session || !client || client.ws?.readyState !== WebSocket.OPEN || session.streamingStartedNotified) return;
    const videoReady = !session.expectedSockets.includes('video') || session.videoSocket;
    const audioReady = !session.expectedSockets.includes('audio') || session.audioSocket;
    const controlReady = !session.expectedSockets.includes('control') || session.controlSocket;
    if (videoReady && audioReady && controlReady) {
        client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.STATUS, message: 'Streaming started' }));
        session.streamingStartedNotified = true;
        if (session.shouldTurnScreenOffOnStart && session.controlSocket && session.options.control === 'true') {
            log(C.LogLevel.INFO, `[Session ${session.scid}] Sending initial screen off command.`);
            const powerMode = 0; const buffer = Buffer.alloc(2);
            buffer.writeUInt8(C.CONTROL_MSG_TYPE_SET_SCREEN_POWER_MODE, 0); buffer.writeUInt8(powerMode, 1);
            try { session.controlSocket.write(buffer); log(C.LogLevel.INFO, `[Session ${session.scid}] Sent initial screen off.`); }
            catch (e) {
                log(C.LogLevel.ERROR, `[Session ${session.scid}] Fail send initial screen off: ${e.message}`);
                if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, message: `Fail send initial screen off: ${e.message}`}));
            }
            session.shouldTurnScreenOffOnStart = false;
        }
        session.batteryInterval = setInterval(async () => {
            try {
                const batteryLevel = await adbService.getBatteryLevel(session.deviceId);
                client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.BATTERY_INFO, success: true, batteryLevel }));
            } catch (error) { log(C.LogLevel.WARN, `Battery check failed for ${session.scid}: ${error.message}`); }
        }, 60000);
        if (session.tunnelActive && session.deviceId) {
            const tunnelString = `localabstract:scrcpy_${session.scid}`;
            try {
                if (await adbService.checkReverseTunnelExists(session.deviceId, tunnelString)) {
                    await adbService.executeCommand(`adb -s ${session.deviceId} reverse --remove ${tunnelString}`, `Remove tunnel post-connect (SCID: ${session.scid})`);
                }
                session.tunnelActive = false;
            } catch (error) { log(C.LogLevel.WARN, `Error removing tunnel post-connect for ${session.scid}: ${error.message}`); }
        }
    }
}

function attemptIdentifyControlByDeduction(session, client) {
    if (!session) return;
    const isControlExpected = session.options.control === 'true';
    if (session.controlSocket || !isControlExpected || session.socketsConnected < session.expectedSockets.length) return;
    const unidentifiedCount = session.unidentifiedSockets?.size || 0;
    const videoIdentified = !session.expectedSockets.includes('video') || session.videoSocket;
    const audioIdentified = !session.expectedSockets.includes('audio') || session.audioSocket;
    if (videoIdentified && audioIdentified && unidentifiedCount === 1) {
        const [remainingSocketId, remainingSocket] = session.unidentifiedSockets.entries().next().value;
        log(C.LogLevel.INFO, `[Session ${session.scid}] Identifying remaining socket ${remainingSocketId} as control.`);
        session.controlSocket = remainingSocket; remainingSocket.type = 'control'; remainingSocket.state = 'STREAMING';
        session.unidentifiedSockets.delete(remainingSocketId);
        const worker = new Worker(path.resolve(__dirname, 'controlWorker.js'), { workerData: { scid: session.scid, clientId: session.clientId, CURRENT_LOG_LEVEL: C.CURRENT_LOG_LEVEL }});
        workers.set(session.scid, worker);
        worker.on('message', (msg) => {
            if (msg.type === 'writeToSocket') {
                const currentSession = sessions.get(msg.scid);
                if (currentSession?.controlSocket && !currentSession.controlSocket.destroyed) {
                    try { currentSession.controlSocket.write(Buffer.from(msg.data.data ? msg.data.data : msg.data)); }
                    catch (e) {
                        const currentClient = client.wsClientsRef?.get(currentSession.clientId);
                        if (currentClient?.ws?.readyState === WebSocket.OPEN) currentClient.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.ERROR, scid: msg.scid, message: `Control error: ${e.message}`}));
                    }}}});
        worker.on('error', (err) => { log(C.LogLevel.ERROR, `[Worker ${session.scid}] Error: ${err.message}`); workers.delete(session.scid); });
        worker.on('exit', (code) => { log(C.LogLevel.INFO, `[Worker ${session.scid}] Exited with code ${code}`); workers.delete(session.scid); });
        checkAndSendStreamingStarted(session, client);
        if (remainingSocket.dynamicBuffer.length > 0) processSingleSocket(remainingSocket, client, session);
    }
}

async function setupScrcpySession(deviceId, scid, port, runOptions, clientId, displayMode, shouldTurnScreenOffOnStartPref, wsClientsRef, decoderType) {
    const session = {
        deviceId, scid, port, clientId, options: runOptions, displayMode, decoderType,
        tcpServer: null, processStream: null, tunnelActive: false,
        videoSocket: null, audioSocket: null, controlSocket: null,
        deviceNameReceived: false, expectedSockets: [], socketsConnected: 0,
        streamingStartedNotified: false, unidentifiedSockets: new Map(),
        audioMetadata: null, maxVolume: null, androidVersion: null,
        currentWidth: 0, currentHeight: 0, batteryInterval: null,
        shouldTurnScreenOffOnStart: shouldTurnScreenOffOnStartPref,
    };
    if (runOptions.video === 'true') session.expectedSockets.push('video');
    if (runOptions.audio === 'true') session.expectedSockets.push('audio');
    if (runOptions.control === 'true') session.expectedSockets.push('control');
    if (session.expectedSockets.length === 0) throw new Error("No streams enabled.");
    sessions.set(scid, session);
    try {
        await adbService.adbPushServer(deviceId);
        log(C.LogLevel.INFO, `[ADB] Pushed server JAR to ${deviceId}`);
        const tunnelString = `localabstract:scrcpy_${scid}`;
        if (await adbService.checkReverseTunnelExists(deviceId, tunnelString)) {
            await adbService.executeCommand(`adb -s ${deviceId} reverse --remove ${tunnelString}`, `Remove specific tunnel (SCID: ${scid})`);
        }
        await adbService.executeCommand(`adb -s ${deviceId} reverse --remove-all`, `Remove all tunnels (SCID: ${scid})`).catch(() => {});
        await adbService.executeCommand(`adb -s ${deviceId} reverse ${tunnelString} tcp:${port}`, `Setup reverse tunnel (SCID: ${scid})`);
        session.tunnelActive = true;
        session.tcpServer = createTcpServer(scid, wsClientsRef);
        await new Promise((resolve, reject) => {
            session.tcpServer.listen(port, '127.0.0.1', resolve);
            session.tcpServer.once('error', reject);
        });
        log(C.LogLevel.INFO, `[TCP] Server listening on 127.0.0.1:${port} for SCID ${scid}`);
        const args = [C.SCRCPY_VERSION, `scid=${scid}`];
        for (const [key, value] of Object.entries(runOptions)) {
            if (value !== undefined && value !== null) args.push(`${key}=${value}`);
        }
        const command = `CLASSPATH=${C.SERVER_DEVICE_PATH} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`;
        log(C.LogLevel.INFO, `[ADB] Executing server on ${deviceId}: adb shell "${command}"`);
        const device = adbService.adb.getDevice(deviceId);
        session.processStream = await device.shell(command);
        session.processStream.on('data', (data) => log(C.LogLevel.INFO, `[scrcpy-server ${scid} std] ${data.toString().trim()}`));
        session.processStream.on('error', (err) => { log(C.LogLevel.ERROR, `[scrcpy-server ${scid}] Stream error: ${err.message}`); cleanupSession(scid, wsClientsRef); });
        session.processStream.on('end', () => { log(C.LogLevel.INFO, `[scrcpy-server ${scid}] Stream ended.`); });
        return session;
    } catch (error) {
        log(C.LogLevel.ERROR, `[Setup] Error in setupScrcpySession for ${scid}: ${error.message}`);
        await cleanupSession(scid, wsClientsRef);
        throw error;
    }
}

async function cleanupSession(scid, wsClientsRef) {
    const session = sessions.get(scid); if (!session) return;
    log(C.LogLevel.INFO, `[Cleanup] Starting cleanup for session ${scid}`);
    sessions.delete(scid);
    const { deviceId, tcpServer, processStream, videoSocket, audioSocket, controlSocket, clientId, unidentifiedSockets, batteryInterval } = session;
    if (batteryInterval) clearInterval(batteryInterval);
    unidentifiedSockets?.forEach(sock => sock.destroy());
    videoSocket?.destroy(); audioSocket?.destroy(); controlSocket?.destroy();
    if (processStream && typeof processStream.end === 'function') {
        try { processStream.end(); log(C.LogLevel.DEBUG, `[Cleanup] Ended process stream for ${scid}`); }
        catch (e) { log(C.LogLevel.WARN, `[Cleanup] Error ending process stream for ${scid}: ${e.message}`); }
    }
    if (tcpServer) { await new Promise(resolve => tcpServer.close(resolve)); log(C.LogLevel.DEBUG, `[Cleanup] Closed TCP server for ${scid}`); }
    const worker = workers.get(scid);
    if (worker) { worker.postMessage({ type: 'stop' }); workers.delete(scid); log(C.LogLevel.DEBUG, `[Cleanup] Stopped worker for ${scid}`); }
    if (session.tunnelActive && deviceId) {
        const tunnelString = `localabstract:scrcpy_${scid}`;
        try {
            if (await adbService.checkReverseTunnelExists(deviceId, tunnelString)) {
                const device = adbService.adb.getDevice(deviceId);
                await device.reverse.remove(tunnelString);
                log(C.LogLevel.INFO, `[ADB] Removed reverse tunnel during cleanup: ${tunnelString}`);
            }
        } catch (error) { log(C.LogLevel.WARN, `[ADB] Error removing reverse tunnel for ${scid}: ${error.message}`); }
    }
    const client = wsClientsRef.get(clientId);
    if (client) {
        if (client.session === scid) client.session = null;
        if (client.ws?.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: C.MESSAGE_TYPES.STATUS, message: 'Streaming stopped by server cleanup' }));
        }
    }
    log(C.LogLevel.INFO, `[Cleanup] Completed cleanup for session ${scid}`);
}

module.exports = {
    setupScrcpySession,
    cleanupSession,
    sessions,
    workers,
};