const crypto = require('node:crypto');
const inventory = require('../docs/community/TEXT_LIMIT_SOURCES.json');
for (const file of inventory.files) {
 const bytes = require('node:fs').readFileSync(require('node:path').join(__dirname,'..',file.path));
 if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Pinned source changed: '+file.path);
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SmlTxt = require('../smltxt/dist/src/SmlTxt.js').default;
const codec = SmlTxt.fromPkg();
const source = fs.readFileSync(path.join(__dirname,'../solidity/contracts/CawActions.sol'),'utf8');
assert(source.includes('bytes text;'));
assert(source.includes('if (action.text.length > 420) revert TextTooLong();'));
const cases = [ ['ascii-420', 'a'.repeat(420)], ['ascii-421', 'a'.repeat(421)], ['ascii-600', 'a'.repeat(600)] ];
const results = cases.map(([id,text]) => {
 const encoded = codec.compress(text);
 assert.equal(codec.decompress(encoded),text);
 return {id,decodedCharacters:text.length,utf8Bytes:Buffer.byteLength(text),compressedBytes:encoded.length,passesContractLengthPredicate:encoded.length<=420,compressedHex:Buffer.from(encoded).toString('hex')};
});
assert(results.some(r=>r.decodedCharacters>420&&r.passesContractLengthPredicate));
console.log(JSON.stringify({scope:'actual pinned codec and source predicate; no EVM, valid signed action, API, transaction or deployment tested',results},null,2));
