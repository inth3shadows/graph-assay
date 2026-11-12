const EventEmitter = require('events')
const profile = new EventEmitter()
function handleSave () { return 'profile' }
profile.on('save', handleSave)
function saveProfile () { profile.emit('save') }
