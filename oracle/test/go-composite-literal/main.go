package gocomplit

import "example.com/gocomplit/shapes"

type T struct{ n int }

type G[V any] struct{ v V }

func NewT() *T { return &T{n: 1} }

func (t *T) Size() int { return t.n }

func literals() int {
	a := &T{n: 1}
	b := T{}
	c := G[int]{}
	d := shapes.Pt{X: 1}
	_ = c
	_ = d
	return a.n + b.n
}

func controls(xs []int, ok bool) int {
	t := NewT()
	total := 0
	for _, x := range xs {
		total += x
	}
	if ok {
		total += t.Size()
	}
	return total + shapes.NewPt().Norm()
}
