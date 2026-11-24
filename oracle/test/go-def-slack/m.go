package repro

type Router struct{}
type Route struct{}

func (r *Router) Path(p string) *Route { return &Route{} }
func (r *Route) Path(p string) *Route { return r }
func (r *Route) Subrouter() *Router { return &Router{} }

type Alpha struct{}
type Beta struct{}

func (a *Alpha) Run() int { return 1 }

func (b *Beta) Run() int { return 2 }
func (b *Beta) Alpha() *Alpha { return &Alpha{} }

func fromNew() {
	sub := new(Route).Subrouter()
	sub.Path("/a")
}

func viaRouter(r *Router) {
	r.Path("/b")
}

func viaRoute(rt *Route) {
	rt.Path("/c")
}

func blankLine() {
	a := new(Beta).Alpha()
	a.Run()
}
