package models

type User struct{ ID int }

func (u User) Save() {}

func (u User) Name() string { return "" }
