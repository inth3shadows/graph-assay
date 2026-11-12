var logger = require('morgan');
var support = require('./support');

function helper(x) { return x; }

function User(name) { this.name = name; }

User.prototype.greet = function greet() {
  return helper(this.name);
};

var api = {
  list: function () {
    return helper(1);
  },
};

[1, 2].forEach(function () { helper(3); });

logger('dev');
new User('a').greet();
api.list();

function run() {
  return support.check();
}

function configure(o) { return o; }

configure({ retry: { delay: () => 1000 } });
track(7);
[4].forEach(function () { return 4; });

function track(x) { return x; }

User.prototype.say = function say() {
  var re = /}/g;
  var s = `\`}`;
  var t = `${`}`}`;
  return shout(re, s, t);
};

function shout() { return 1; }

configure({ retry: { delay: () => 0, shouldRetry: () => { return ping(1); } } });

function ping(x) { return x; }
