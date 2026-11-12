package p

type Route struct{}

func (r *Route) Host(h string) *Route { return r }
