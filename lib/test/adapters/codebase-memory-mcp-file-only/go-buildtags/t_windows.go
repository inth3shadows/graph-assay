//go:build windows

package x

type T struct{ h uintptr }

func (t *T) Close() error { return nil }

func (t *T) Handle() uintptr { return t.h }

func open() *T { return &T{} }
