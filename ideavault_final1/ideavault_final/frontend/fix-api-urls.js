/**
 * Fix window.location.origin -> robust fallback to http://localhost:5000/api
 * Run: node fix-api-urls.js
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const exts = ['.js', '.html'];
const targetReplacement = `(window.location.origin && window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:5000') + '/api'`;

const files = fs.readdirSync(dir).filter(f => exts.some(e => f.endsWith(e)));
let totalFixed = 0;

files.forEach(file => {
  if (file === 'fix-api-urls.js') return;
  const fp = path.join(dir, file);
  let content = fs.readFileSync(fp, 'utf8');
  
  // We want to replace occurrences of window.location.origin + '/api'
  // and variations of global.__IV_API__ || window.location.origin + '/api'
  let updated = content;
  
  // Normalize simple ones first
  updated = updated.replace(/window\.location\.origin\s*\+\s*['"]\/api['"]/g, targetReplacement);
  
  if (updated !== content) {
    fs.writeFileSync(fp, updated, 'utf8');
    console.log('Fixed:', file);
    totalFixed++;
  }
});

console.log('\nTotal files fixed:', totalFixed);
