package p

func viaNew() *Route {
	return new(Route).Host("x")
}

func viaLiteral() *Route {
	return (&Route{}).Host("y")
}

func viaVar() *Route {
	r := new(Route)
	return r.Host("z")
}
