const fs = require('fs');

const fixes = [
  ['worker.js', "const VERSION = '2.28.1'", "const VERSION = '2.28.2'"],
  ['public/js/main.js', "const VERSION = '2.28.1'", "const VERSION = '2.28.2'"],
  ['public/sw.js', "const VERSION = 'v2.28.1'", "const VERSION = 'v2.28.2'"]
];

for (const [file, old, rep] of fixes) {
  let c = fs.readFileSync(file, 'utf8');
  if (c.includes(old)) {
    fs.writeFileSync(file, c.replace(old, rep), 'utf8');
    console.log(`${file}: OK`);
  } else {
    console.error(`${file}: NOT FOUND`);
  }
}
