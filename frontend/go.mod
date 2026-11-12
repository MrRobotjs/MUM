// Keeps frontend/ (and the Go sources some npm packages ship inside
// node_modules) out of the root module's `go build/vet/test ./...`.
module mum/frontend-excluded

go 1.27
