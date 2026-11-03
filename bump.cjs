const fs = require('fs');

// Bump version to 2.28.2 in all 4 files
const files = {
  'package.json': [/"version":\s*"2\.28\.1"/, '"version": "2.28.2"'],
  'worker.js': [/const APP_VERSION = '2\.28\.1'/, "const APP_VERSION = '2.28.2'"],
  'public/js/main.js': [/const APP_VERSION = '2\.28\.1'/, "const APP_VERSION = '2.28.2'"],
  'public/sw.js': [/const CACHE = 'sp-2\.28\.1'/, "const CACHE = 'sp-2.28.2'"]
};

for (const [file, [pattern, replacement]] of Object.entries(files)) {
  let content = fs.readFileSync(file, 'utf8');
  if (pattern.test(content)) {
    content = content.replace(pattern, replacement);
    fs.writeFileSync(file, content, 'utf8');
    console.log(`${file}: bumped to 2.28.2`);
  } else {
    console.error(`${file}: pattern not found!`);
  }
}
