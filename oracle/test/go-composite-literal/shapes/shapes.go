package shapes

type Pt struct{ X, Y int }

func (p Pt) Norm() int { return p.X + p.Y }

func NewPt() *Pt { return &Pt{} }
