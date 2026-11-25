//go:build linux

package x

type T struct{ fd int }

func (t *T) Close() error { return nil }

func open() *T { return &T{} }
