package p

type Router struct{}

func (r *Router) Host(h string) *Router { return r }
