import assert from 'node:assert/strict'
import { isEmbedLegalBlockText } from '../src/lib/webBrowser.ts'

const toshiba = `Error 451
Unavailable For Legal Reasons
What happened?
This website is unavailable for legal reasons.
Please see https://lumendatabase.org/notices/102910145 for more details.`

assert.equal(isEmbedLegalBlockText(toshiba), true)
assert.equal(isEmbedLegalBlockText('Atlético Madrid vs. Barcelona'), false)
assert.equal(isEmbedLegalBlockText(''), false)

console.log('legal block checks passed')
