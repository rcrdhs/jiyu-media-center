import assert from 'node:assert/strict'
import { shouldResumePendingCatalog } from '../src/lib/catalogClosePolicy.ts'

assert.equal(
  shouldResumePendingCatalog({
    closedByAppExit: true,
    pendingSourceIds: ['yts'],
    syncAlreadyRunning: false,
  }),
  false,
  'closing Jiyu cancels the pending catalog job instead of resuming it',
)

assert.equal(
  shouldResumePendingCatalog({
    closedByAppExit: false,
    pendingSourceIds: ['yts'],
    syncAlreadyRunning: true,
  }),
  false,
  'an in-page sync that is still running is not started a second time',
)

assert.equal(
  shouldResumePendingCatalog({
    closedByAppExit: false,
    pendingSourceIds: ['yts', ''],
    syncAlreadyRunning: false,
  }),
  true,
  'a job left by a process kill while the app was not closed can resume',
)

assert.equal(
  shouldResumePendingCatalog({
    closedByAppExit: false,
    pendingSourceIds: [],
    syncAlreadyRunning: false,
  }),
  false,
)

console.log('catalog close policy: ok')
