package repro

func closureSameName() {
	split := func(r *Route) (*Route, *Router) { return r, r.Subrouter() }
	_, r := split(new(Route))
	r.Path("/b")
}

func closureRenamed() {
	split := func(x *Route) (*Route, *Router) { return x, x.Subrouter() }
	_, r := split(new(Route))
	r.Path("/b")
}

func splitFn(r *Route) (*Route, *Router) { return r, r.Subrouter() }

func topLevel() {
	_, r := splitFn(new(Route))
	r.Path("/b")
}
