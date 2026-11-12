const EventEmitter = require('events')
const cart = new EventEmitter()
function handleSave () { return 'cart' }
cart.on('save', handleSave)
function saveCart () { cart.emit('save') }
