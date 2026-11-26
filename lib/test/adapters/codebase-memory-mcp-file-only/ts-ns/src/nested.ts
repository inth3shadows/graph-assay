export namespace Outer { export namespace Inner { export function f() { g(); } } export function g() {} }
export function top() { Outer.Inner.f(); }
