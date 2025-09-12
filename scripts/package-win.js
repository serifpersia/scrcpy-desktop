const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

const output = fs.createWriteStream(path.join(__dirname, '..', 'scrcpy-desktop-win-native.zip'));
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', function() {
  console.log(archive.pointer() + ' total bytes');
  console.log('Archiver has been finalized and the output file descriptor has closed.');
});

archive.on('error', function(err) {
  throw err;
});

archive.pipe(output);
archive.directory(path.join(__dirname, '..', 'public', 'dist'), 'scrcpy-desktop/public/dist');
archive.file(path.join(__dirname, '..', 'public', 'vendor', 'Genymobile', 'scrcpy-server', 'scrcpy-server-v3.2'), { name: 'scrcpy-desktop/public/vendor/Genymobile/scrcpy-server/scrcpy-server-v3.2' });
archive.directory(path.join(__dirname, '..', 'src-server'), 'scrcpy-desktop/src-server', { ignore: ['native/binding.gyp', 'native/scrcpy_native.cc', 'native/build/obj.target/**'] });
archive.file(path.join(__dirname, '..', 'package.json'), { name: 'scrcpy-desktop/package.json' });
archive.file(path.join(__dirname, '..', 'package-lock.json'), { name: 'scrcpy-desktop/package-lock.json' });
archive.file(path.join(__dirname, '..', 'README.md'), { name: 'scrcpy-desktop/README.md' });
archive.file(path.join(__dirname, '..', 'LICENSE'), { name: 'scrcpy-desktop/LICENSE' });
archive.file(path.join(__dirname, '..', 'scripts', 'start.bat'), { name: 'scrcpy-desktop/start.bat' });
archive.file(path.join(__dirname, '..', 'scripts', 'start.sh'), { name: 'scrcpy-desktop/start.sh' });
archive.finalize();