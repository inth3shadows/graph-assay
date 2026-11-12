function Reply () {}
Reply.prototype.getHeader = function (k) { return k }
Reply.prototype.send = function () { return this.getHeader('content-type') }   // line 4
module.exports = Reply
