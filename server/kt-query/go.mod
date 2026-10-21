module github.com/h4nzs/nyx-chat/server/kt-query

go 1.27.0

// `github.com/signalapp/keytransparency` TIDAK dapat diambil dari jaringan
// (repo privat — `git ls-remote` menjawab "Repository not found"). Karena itu
// modul ini **ter-vendor penuh** di `vendor/github.com/signalapp/keytransparency`
// (dihasilkan `go mod vendor` dari checkout upstream yang di-pin, `docs/32`
// §32.1: commit 30b7a2a40604) — tidak ada directive `replace`, jadi `go build`
// tidak menyentuh jaringan maupun checkout di luar repo.
//
// Memperbarui sink: jalankan `scripts/vendor-signal.sh`, lalu (dari direktori
// ini) `go mod vendor` terhadap checkout upstream pada pin baru. Detail: README.
require github.com/signalapp/keytransparency v0.0.0

require (
	github.com/syndtr/goleveldb v1.0.0
	google.golang.org/grpc v1.82.1
	google.golang.org/protobuf v1.36.11
	gopkg.in/yaml.v2 v2.4.0
)

require (
	filippo.io/edwards25519 v1.2.0 // indirect
	github.com/aws/aws-sdk-go-v2 v1.43.1 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.7.15 // indirect
	github.com/aws/aws-sdk-go-v2/config v1.32.32 // indirect
	github.com/aws/aws-sdk-go-v2/credentials v1.19.31 // indirect
	github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue v1.20.55 // indirect
	github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression v1.8.55 // indirect
	github.com/aws/aws-sdk-go-v2/feature/ec2/imds v1.18.32 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.4.32 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.7.32 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.4.33 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodb v1.62.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/dynamodbstreams v1.36.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.13.14 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/endpoint-discovery v1.12.9 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.13.32 // indirect
	github.com/aws/aws-sdk-go-v2/service/kinesis v1.46.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/signin v1.5.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/sso v1.33.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/ssooidc v1.38.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/sts v1.45.1 // indirect
	github.com/aws/smithy-go v1.27.5 // indirect
	github.com/awslabs/kinesis-aggregation/go/v2 v2.0.0-20241004223953-c2774b1ab29b // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/golang/snappy v1.0.0 // indirect
	github.com/harlow/kinesis-consumer v0.5.0 // indirect
	github.com/hashicorp/go-immutable-radix v1.3.1 // indirect
	github.com/hashicorp/go-metrics v0.6.1 // indirect
	github.com/hashicorp/golang-lru v1.0.2 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
)

