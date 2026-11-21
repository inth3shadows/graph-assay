package repro

func fromNew() {
	sub := new(Route).Host("x").Subrouter()
	sub.Path("/a")
}

func fromNewShort() {
	sub := new(Route).Subrouter()
	sub.Path("/a")
}

func fromLiteral() {
	sub := (&Route{}).Host("x").Subrouter()
	sub.Path("/a")
}

func fromFunc() {
	sub := NewRoute().Host("x").Subrouter()
	sub.Path("/a")
}

func fromLocal() {
	rt := new(Route)
	sub := rt.Subrouter()
	sub.Path("/a")
}
