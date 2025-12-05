const fs = require('fs');
const key = fs.readFileSync('./dragon-news-auth-7bc5f-firebase-adminsdk-fbsvc-201f826be6.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
console.log(base64)