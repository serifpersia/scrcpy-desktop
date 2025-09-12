#include <napi.h>
#include <vector>
#include <string>
#include <algorithm>
#include <map>

// Helper to convert Napi::Buffer to std::vector<uint8_t>
std::vector<uint8_t> NapiBufferToVector(const Napi::Buffer<uint8_t>& buffer) {
    std::vector<uint8_t> vec(buffer.Length());
    memcpy(vec.data(), buffer.Data(), buffer.Length());
    return vec;
}

// Helper to convert std::vector<uint8_t> to Napi::Buffer
Napi::Buffer<uint8_t> VectorToNapiBuffer(Napi::Env env, const std::vector<uint8_t>& vec) {
    return Napi::Buffer<uint8_t>::Copy(env, vec.data(), vec.size());
}

// Internal helper for extracting NALU payload
Napi::Buffer<uint8_t> ExtractNaluPayloadInternal(Napi::Env env, const Napi::Buffer<uint8_t>& naluBufferWithStartCode) {
    size_t length = naluBufferWithStartCode.Length();

    if (length < 3) {
        return naluBufferWithStartCode; // Return original if too short to have a start code
    }

    size_t offset = 0;
    if (length >= 4 && naluBufferWithStartCode[0] == 0 && naluBufferWithStartCode[1] == 0 && naluBufferWithStartCode[2] == 0 && naluBufferWithStartCode[3] == 1) {
        offset = 4;
    } else if (length >= 3 && naluBufferWithStartCode[0] == 0 && naluBufferWithStartCode[1] == 0 && naluBufferWithStartCode[2] == 1) {
        offset = 3;
    }

    if (offset > 0) {
        return Napi::Buffer<uint8_t>::Copy(env, naluBufferWithStartCode.Data() + offset, length - offset);
    } else {
        return naluBufferWithStartCode;
    }
}

// N-API wrapper for ExtractNaluPayloadInternal
Napi::Value ExtractNaluPayload(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer as the first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> naluBufferWithStartCode = info[0].As<Napi::Buffer<uint8_t>>();
    return ExtractNaluPayloadInternal(env, naluBufferWithStartCode);
}

// extractSingleNalu function
Napi::Value ExtractSingleNalu(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Expected a Buffer and a Number as arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    int naluTypeToFind = info[1].As<Napi::Number>().Int32Value();

    size_t offset = 0;
    const uint8_t* data = buffer.Data();
    size_t length = buffer.Length();

    const uint8_t pattern3Byte[] = {0x00, 0x00, 0x01};
    const uint8_t pattern4Byte[] = {0x00, 0x00, 0x00, 0x01};

    while (offset < length) {
        size_t startCodeOffset = std::string::npos;
        size_t startCodeLength = 0;

        // Find 4-byte start code
        for (size_t i = offset; i + 3 < length; ++i) {
            if (data[i] == pattern4Byte[0] && data[i+1] == pattern4Byte[1] && data[i+2] == pattern4Byte[2] && data[i+3] == pattern4Byte[3]) {
                startCodeOffset = i;
                startCodeLength = 4;
                break;
            }
        }

        // If 4-byte not found, find 3-byte start code
        if (startCodeOffset == std::string::npos) {
            for (size_t i = offset; i + 2 < length; ++i) {
                if (data[i] == pattern3Byte[0] && data[i+1] == pattern3Byte[1] && data[i+2] == pattern3Byte[2]) {
                    startCodeOffset = i;
                    startCodeLength = 3;
                    break;
                }
            }
        }

        if (startCodeOffset == std::string::npos) {
            break; // No more start codes found
        }
        
        if (startCodeOffset + startCodeLength >= length) {
            break; // Start code at end of buffer
        }

        uint8_t currentNaluType = data[startCodeOffset + startCodeLength] & 0x1F;

        if (currentNaluType == naluTypeToFind) {
            size_t nextNaluStart = std::string::npos;

            // Find the start of the next NALU
            for (size_t i = startCodeOffset + startCodeLength; i + 3 < length; ++i) {
                if (data[i] == pattern4Byte[0] && data[i+1] == pattern4Byte[1] && data[i+2] == pattern4Byte[2] && data[i+3] == pattern4Byte[3]) {
                    nextNaluStart = i;
                    break;
                }
                if (i + 2 < length && data[i] == pattern3Byte[0] && data[i+1] == pattern3Byte[1] && data[i+2] == pattern3Byte[2]) {
                    nextNaluStart = i;
                    break;
                }
            }

            if (nextNaluStart != std::string::npos) {
                return Napi::Buffer<uint8_t>::Copy(env, data + startCodeOffset, nextNaluStart - startCodeOffset);
            } else {
                return Napi::Buffer<uint8_t>::Copy(env, data + startCodeOffset, length - startCodeOffset);
            }
        }
        offset = startCodeOffset + startCodeLength;
    }
    return env.Null(); // NALU not found
}

// createAVCC function
Napi::Value CreateAVCC(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsBuffer() || !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "Expected two Buffers (SPS and PPS) as arguments").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> spsNaluWithStartCode = info[0].As<Napi::Buffer<uint8_t>>();
    Napi::Buffer<uint8_t> ppsNaluWithStartCode = info[1].As<Napi::Buffer<uint8_t>>();

    Napi::Buffer<uint8_t> sps = ExtractNaluPayloadInternal(env, spsNaluWithStartCode);
    Napi::Buffer<uint8_t> pps = ExtractNaluPayloadInternal(env, ppsNaluWithStartCode);

    if (sps.Length() == 0 || pps.Length() == 0 || sps.Length() < 4) {
        return env.Null();
    }

    size_t avccBoxSize = 1 + 3 + 1 + 1 + 2 + sps.Length() + 1 + 2 + pps.Length();
    std::vector<uint8_t> avccBox(avccBoxSize);
    size_t offset = 0;

    avccBox[offset++] = 1; // configuration_version
    avccBox[offset++] = sps[1]; // AVCProfileIndication
    avccBox[offset++] = sps[2]; // profile_compatibility
    avccBox[offset++] = sps[3]; // AVCLevelIndication
    avccBox[offset++] = 0xFC | 3; // lengthSizeMinusOne (0xFF for 4 bytes, 0xFC for 3 bytes)
    
    avccBox[offset++] = 0xE0 | 1; // numOfSequenceParameterSets (1 SPS)
    // sps_length
    avccBox[offset++] = (sps.Length() >> 8) & 0xFF;
    avccBox[offset++] = sps.Length() & 0xFF;
    // sps_nalu_data
    memcpy(avccBox.data() + offset, sps.Data(), sps.Length());
    offset += sps.Length();
    
    avccBox[offset++] = 1; // numOfPictureParameterSets (1 PPS)
    // pps_length
    avccBox[offset++] = (pps.Length() >> 8) & 0xFF;
    avccBox[offset++] = pps.Length() & 0xFF;
    // pps_nalu_data
    memcpy(avccBox.data() + offset, pps.Data(), pps.Length());
    offset += pps.Length();
    
    return Napi::Buffer<uint8_t>::Copy(env, avccBox.data(), offset);
}

// annexBToLengthPrefixed function
Napi::Value AnnexBToLengthPrefixed(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer as the first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> annexBBuffer = info[0].As<Napi::Buffer<uint8_t>>();
    const uint8_t* data = annexBBuffer.Data();
    size_t length = annexBBuffer.Length();

    std::vector<std::vector<uint8_t>> nalus;
    size_t offset = 0;

    const uint8_t START_CODE_3[] = {0x00, 0x00, 0x01};
    const uint8_t START_CODE_4[] = {0x00, 0x00, 0x00, 0x01};

    while (offset < length) {
        size_t startCodeOffset = std::string::npos;
        size_t startCodeLength = 0;

        // Find 4-byte start code
        for (size_t i = offset; i + 3 < length; ++i) {
            if (data[i] == START_CODE_4[0] && data[i+1] == START_CODE_4[1] && data[i+2] == START_CODE_4[2] && data[i+3] == START_CODE_4[3]) {
                startCodeOffset = i;
                startCodeLength = 4;
                break;
            }
        }

        // If 4-byte not found, find 3-byte start code
        if (startCodeOffset == std::string::npos) {
            for (size_t i = offset; i + 2 < length; ++i) {
                if (data[i] == START_CODE_3[0] && data[i+1] == START_CODE_3[1] && data[i+2] == START_CODE_3[2]) {
                    startCodeOffset = i;
                    startCodeLength = 3;
                    break;
                }
            }
        }

        if (startCodeOffset == std::string::npos) {
            break; // No more start codes found
        }
        
        if (startCodeOffset + startCodeLength >= length) {
            break; // Start code at end of buffer
        }

        // Check if there's data before the first start code, treat it as a NALU
        if (startCodeOffset > offset) {
            nalus.push_back(std::vector<uint8_t>(data + offset, data + startCodeOffset));
        }

        offset = startCodeOffset + startCodeLength;

        size_t nextNaluStart = std::string::npos;

        // Find the start of the next NALU
        for (size_t i = offset; i + 3 < length; ++i) {
            if (data[i] == START_CODE_4[0] && data[i+1] == START_CODE_4[1] && data[i+2] == START_CODE_4[2] && data[i+3] == START_CODE_4[3]) {
                nextNaluStart = i;
                break;
            }
            if (i + 2 < length && data[i] == START_CODE_3[0] && data[i+1] == START_CODE_3[1] && data[i+2] == START_CODE_3[2]) {
                nextNaluStart = i;
                break;
            }
        }

        if (nextNaluStart != std::string::npos) {
            nalus.push_back(std::vector<uint8_t>(data + offset, data + nextNaluStart));
            offset = nextNaluStart;
        } else {
            nalus.push_back(std::vector<uint8_t>(data + offset, data + length));
            offset = length;
        }
    }

    std::vector<uint8_t> resultBuffer;
    for (const auto& nalu : nalus) {
        if (nalu.empty()) continue;
        // Write NALU length (4 bytes, big-endian)
        resultBuffer.push_back((nalu.size() >> 24) & 0xFF);
        resultBuffer.push_back((nalu.size() >> 16) & 0xFF);
        resultBuffer.push_back((nalu.size() >> 8) & 0xFF);
        resultBuffer.push_back(nalu.size() & 0xFF);
        // Write NALU data
        resultBuffer.insert(resultBuffer.end(), nalu.begin(), nalu.end());
    }

    return VectorToNapiBuffer(env, resultBuffer);
}

// BitReader class for SPS parsing
class BitReader {
public:
    BitReader(const uint8_t* buffer, size_t length) : buffer_(buffer), length_(length), bytePosition_(0), bitPosition_(0) {}

    int ReadBits(int n) {
        if (n == 0) return 0;
        if (n > 32) return -1; // Indicate error

        int result = 0;
        for (int i = 0; i < n; ++i) {
            if (bytePosition_ >= length_) return -1; // Indicate error
            result <<= 1;
            result |= (buffer_[bytePosition_] >> (7 - bitPosition_)) & 1;
            bitPosition_++;
            if (bitPosition_ == 8) {
                bitPosition_ = 0;
                bytePosition_++;
            }
        }
        return result;
    }

    int ReadUE() {
        int leadingZeroBits = 0;
        while (ReadBits(1) == 0) {
            leadingZeroBits++;
            if (leadingZeroBits > 31) return -1; // Indicate error
        }
        if (leadingZeroBits == 0) return 0;
        int valueSuffix = ReadBits(leadingZeroBits);
        if (valueSuffix == -1) return -1; // Indicate error
        return (1 << leadingZeroBits) - 1 + valueSuffix;
    }

    int ReadSE() {
        int codeNum = ReadUE();
        if (codeNum == -1) return -1; // Indicate error
        return (codeNum % 2 == 0) ? -(codeNum / 2) : (codeNum + 1) / 2;
    }

    bool ReadBool() {
        int bit = ReadBits(1);
        if (bit == -1) return false; // Indicate error
        return bit == 1;
    }

private:
    const uint8_t* buffer_;
    size_t length_;
    size_t bytePosition_;
    int bitPosition_;
};

// parseSPS function
Napi::Value ParseSPS(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer as the first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> naluBufferWithStartCode = info[0].As<Napi::Buffer<uint8_t>>();
    size_t length = naluBufferWithStartCode.Length();

    if (length < 1) return env.Null();

    size_t offset = 0;
    if (length >= 4 && naluBufferWithStartCode[0] == 0 && naluBufferWithStartCode[1] == 0 && naluBufferWithStartCode[2] == 0 && naluBufferWithStartCode[3] == 1) {
        offset = 4;
    } else if (length >= 3 && naluBufferWithStartCode[0] == 0 && naluBufferWithStartCode[1] == 0 && naluBufferWithStartCode[2] == 1) {
        offset = 3;
    }

    const uint8_t* rbspBuffer = naluBufferWithStartCode.Data() + offset;
    size_t rbspLength = length - offset;

    if (rbspLength < 4) return env.Null();
    uint8_t nal_unit_type = rbspBuffer[0] & 0x1F;
    if (nal_unit_type != 7) return env.Null();

    uint8_t profile_idc_val = rbspBuffer[1];
    uint8_t profile_compatibility_val = rbspBuffer[2];
    uint8_t level_idc_val = rbspBuffer[3];

    BitReader reader(rbspBuffer + 1, rbspLength - 1);

    try {
        int profile_idc = reader.ReadBits(8);
        int constraint_set_flags = reader.ReadBits(8);
        int level_idc = reader.ReadBits(8);
        reader.ReadUE(); // seq_parameter_set_id

        if (profile_idc == -1) return env.Null();

        int chroma_format_idc = 1;
        bool separate_colour_plane_flag = false;

        std::vector<int> high_profile_ids = {100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135};
        if (std::find(high_profile_ids.begin(), high_profile_ids.end(), profile_idc) != high_profile_ids.end()) {
            chroma_format_idc = reader.ReadUE();
            if (chroma_format_idc == -1 || chroma_format_idc > 3) return env.Null();
            if (chroma_format_idc == 3) {
                separate_colour_plane_flag = reader.ReadBool();
            }
            reader.ReadUE(); // bit_depth_luma_minus8
            reader.ReadUE(); // bit_depth_chroma_minus8
            reader.ReadBool(); // qpprime_y_zero_transform_bypass_flag
            bool seq_scaling_matrix_present_flag = reader.ReadBool();
            if (seq_scaling_matrix_present_flag) {
                int limit = (chroma_format_idc != 3) ? 8 : 12;
                for (int i = 0; i < limit; ++i) {
                    if (reader.ReadBool()) {
                        int sizeOfScalingList = (i < 6) ? 16 : 64;
                        int lastScale = 8, nextScale = 8;
                        for (int j = 0; j < sizeOfScalingList; ++j) {
                            int delta_scale = reader.ReadSE();
                            if (delta_scale == -1) return env.Null();
                            nextScale = (lastScale + delta_scale + 256) % 256;
                            lastScale = (nextScale == 0) ? lastScale : nextScale;
                        }
                    }
                }
            }
        }

        reader.ReadUE(); // log2_max_frame_num_minus4
        int pic_order_cnt_type = reader.ReadUE();
        if (pic_order_cnt_type == -1) return env.Null();

        if (pic_order_cnt_type == 0) {
            reader.ReadUE(); // log2_max_pic_order_cnt_lsb_minus4
        } else if (pic_order_cnt_type == 1) {
            reader.ReadBool(); // delta_pic_order_always_zero_flag
            reader.ReadSE(); // offset_for_non_ref_pic
            reader.ReadSE(); // offset_for_top_to_bottom_field
            int num_ref_frames_in_pic_order_cnt_cycle = reader.ReadUE();
            if (num_ref_frames_in_pic_order_cnt_cycle == -1) return env.Null();
            for (int i = 0; i < num_ref_frames_in_pic_order_cnt_cycle; ++i) {
                reader.ReadSE(); // offset_for_ref_frame[i]
            }
        }

        reader.ReadUE(); // num_ref_frames
        reader.ReadBool(); // gaps_in_frame_num_value_allowed_flag

        int pic_width_in_mbs_minus1 = reader.ReadUE();
        int pic_height_in_map_units_minus1 = reader.ReadUE();
        bool frame_mbs_only_flag = reader.ReadBool();

        if (pic_width_in_mbs_minus1 == -1 || pic_height_in_map_units_minus1 == -1) return env.Null();

        if (!frame_mbs_only_flag) {
            reader.ReadBool(); // mb_adaptive_frame_field_flag
        }
        reader.ReadBool(); // direct_8x8_inference_flag

        bool frame_cropping_flag = reader.ReadBool();
        int frame_crop_left_offset = 0, frame_crop_right_offset = 0, frame_crop_top_offset = 0, frame_crop_bottom_offset = 0;

        if (frame_cropping_flag) {
            frame_crop_left_offset = reader.ReadUE();
            frame_crop_right_offset = reader.ReadUE();
            frame_crop_top_offset = reader.ReadUE();
            frame_crop_bottom_offset = reader.ReadUE();
            if (frame_crop_left_offset == -1 || frame_crop_right_offset == -1 || frame_crop_top_offset == -1 || frame_crop_bottom_offset == -1) return env.Null();
        }

        int pic_width_in_mbs = pic_width_in_mbs_minus1 + 1;
        int pic_height_in_map_units = pic_height_in_map_units_minus1 + 1;
        int frame_height_in_mbs = (2 - (frame_mbs_only_flag ? 1 : 0)) * pic_height_in_map_units;

        int width = pic_width_in_mbs * 16;
        int height = frame_height_in_mbs * 16;

        if (frame_cropping_flag) {
            int subWidthC = 1, subHeightC = 1;
            if (!separate_colour_plane_flag) {
                if (chroma_format_idc == 1) { subWidthC = 2; subHeightC = 2; }
                else if (chroma_format_idc == 2) { subWidthC = 2; subHeightC = 1; }
            }
            int cropUnitX = subWidthC;
            int cropUnitY = subHeightC * (2 - (frame_mbs_only_flag ? 1 : 0));

            width -= (frame_crop_left_offset + frame_crop_right_offset) * cropUnitX;
            height -= (frame_crop_top_offset + frame_crop_bottom_offset) * cropUnitY;
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("width", Napi::Number::New(env, width));
        result.Set("height", Napi::Number::New(env, height));
        result.Set("profile_idc", Napi::Number::New(env, profile_idc_val));
        result.Set("profile_compatibility", Napi::Number::New(env, profile_compatibility_val));
        result.Set("level_idc", Napi::Number::New(env, level_idc_val));
        return result;

    } catch (const Napi::Error& e) {
        // This catch block is for Napi errors thrown by Napi::TypeError::New etc.
        // For internal parsing errors, the ReadBits/ReadUE/ReadSE functions return -1.
        return env.Null();
    } catch (...) {
        return env.Null();
    }
}

// parseAudioSpecificConfig function
Napi::Value ParseAudioSpecificConfig(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::TypeError::New(env, "Expected a Buffer as the first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    const uint8_t* data = buffer.Data();
    size_t length = buffer.Length();

    if (length == 0) return env.Null();

    size_t offset = 0;
    int bits = 0;
    int bitCount = 0;

    auto readBits = [&](int numBits) -> int {
        while (bitCount < numBits) {
            if (offset >= length) return -1; // Error: ran out of data
            bits = (bits << 8) | data[offset++];
            bitCount += 8;
        }
        bitCount -= numBits;
        int result = (bits >> bitCount) & ((1 << numBits) - 1);
        bits &= (1 << bitCount) - 1;
        return result;
    };

    try {
        int objectType = readBits(5);
        if (objectType == -1) return env.Null();

        int sampleRateIndex = readBits(4);
        if (sampleRateIndex == -1) return env.Null();

        int sampleRate = 0;
        std::map<int, int> sampleRateMap = {
            {0, 96000}, {1, 88200}, {2, 64000}, {3, 48000}, {4, 44100}, {5, 32000},
            {6, 24000}, {7, 22050}, {8, 16000}, {9, 12000}, {10, 11025}, {11, 8000},
            {12, 7350}
        };

        if (sampleRateIndex == 15) {
            sampleRate = readBits(24);
            if (sampleRate == -1) return env.Null();
        } else {
            auto it = sampleRateMap.find(sampleRateIndex);
            if (it != sampleRateMap.end()) {
                sampleRate = it->second;
            } else {
                return env.Null(); // Unsupported sample rate index
            }
        }

        int channelConfig = readBits(4);
        if (channelConfig == -1) return env.Null();

        std::map<int, int> profileMap = {{2, 1}, {5, 4}, {29, 28}};
        auto profileIt = profileMap.find(objectType);
        if (profileIt == profileMap.end()) {
            // log(C.LogLevel.WARN, `Unsupported AAC object type: ${objectType}`); // Cannot use C.LogLevel here
            return env.Null();
        }
        int profile = profileIt->second;

        if (sampleRate == 0) {
            // log(C.LogLevel.WARN, `Unsupported sample rate: ${sampleRate}`);
            return env.Null();
        }
        if (channelConfig < 1 || channelConfig > 7) {
            // log(C.LogLevel.WARN, `Unsupported channel configuration: ${channelConfig}`);
            return env.Null();
        }

        Napi::Object result = Napi::Object::New(env);
        result.Set("profile", Napi::Number::New(env, profile));
        result.Set("sampleRateIndex", Napi::Number::New(env, sampleRateIndex));
        result.Set("sampleRate", Napi::Number::New(env, sampleRate));
        result.Set("channelConfig", Napi::Number::New(env, channelConfig));
        result.Set("rawASC", buffer); // Return the original buffer as rawASC
        return result;

    } catch (const Napi::Error& e) {
        return env.Null();
    } catch (...) {
        return env.Null();
    }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("extractNaluPayload", Napi::Function::New(env, ExtractNaluPayload));
    exports.Set("extractSingleNalu", Napi::Function::New(env, ExtractSingleNalu));
    exports.Set("createAVCC", Napi::Function::New(env, CreateAVCC));
    exports.Set("annexBToLengthPrefixed", Napi::Function::New(env, AnnexBToLengthPrefixed));
    exports.Set("parseSPS", Napi::Function::New(env, ParseSPS));
    exports.Set("parseAudioSpecificConfig", Napi::Function::New(env, ParseAudioSpecificConfig));
    return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
