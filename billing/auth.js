'use strict';
const crypto=require('crypto');
function makeHash(password){const salt=crypto.randomBytes(16).toString('hex');return 'scrypt$'+salt+'$'+crypto.scryptSync(password,salt,64).toString('hex')}
function verifyHash(stored,password){const parts=String(stored).split('$');if(parts.length===3&&parts[0]==='scrypt'){const expected=Buffer.from(parts[2],'hex'),given=crypto.scryptSync(password,Buffer.from(parts[1],'hex'),64);return expected.length===given.length&&crypto.timingSafeEqual(expected,given)}return stored===password}
module.exports={makeHash,verifyHash};
