package repro

type Route struct{}

func (r *Route) Path(p string) *Route { return r }
func (r *Route) Subrouter() *Router   { return &Router{} }
