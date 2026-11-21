package repro

type Router struct{}

func (r *Router) Path(p string) *Route { return &Route{} }
