package gopairs

import "strings"

type Store struct{ items map[string]interface{} }

func helper(k string) string { return k }

func (s *Store) Get(k string) interface{} {
	return s.items[helper(k)]
}

func (s *Store) Rows() []struct{ K string } {
	out := []struct{ K string }{{K: helper("a")}}
	return out
}

func (s *Store) Put(k string, v interface{}) {
	s.items[helper(k)] = v
}

func (s *Store) Path(k string) string {
	p := strings.ReplaceAll(k, `\`, `/`)
	return helper(p)
}

func (s *Store) Cmd() string {
	sh := `echo ${HOME`
	return helper(sh)
}
