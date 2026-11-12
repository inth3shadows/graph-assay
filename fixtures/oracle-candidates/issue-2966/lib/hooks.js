'use strict'
function Hooks () { this.list = [] }
Hooks.prototype.validate = function (hook, fn) { return typeof fn === 'function' }
Hooks.prototype.add = function (hook, fn) {
  this.validate(hook, fn)                       // line 5
  this.list.push(fn)
}
module.exports = Hooks
