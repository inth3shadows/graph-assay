package p

type Router struct{}
type Route struct{}

func (r *Router) Match() bool { return true }
func (r *Route) Match() bool { return false }

func helper() int { return 1 }
