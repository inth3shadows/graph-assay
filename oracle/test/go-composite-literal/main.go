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

type Options struct{ v int }

type S struct{}

func (s *S) Options(o Options) int { return o.v }

func collisions(s *S) int {
	return s.Options(Options{v: 1})
}

func mk() T { return T{n: 2} }

func mk2() T {
	return T{n: 4}
}

func nested() int {
	m := G[map[string]int]{}
	l := []T{{n: 1}}
	_ = m
	return len(l)
}

func unicode() T {
	s := "héllo→"; _ = s; return T{n: 3}
}

func long(
	a int,
) T {
	return T{n: a}
}
