XHRPUT
https://chat-lite-weld.vercel.app/api/users/me
[HTTP/2 522  20048ms]

	
PUT
	https://chat-lite-weld.vercel.app/api/users/me
Status
522
VersionHTTP/2
Transferred451.30 kB (450.77 kB size)
Referrer Policystrict-origin-when-cross-origin
Request PriorityHighest
DNS ResolutionSystem

	
cache-control
	private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0
cf-ray
	9c57f17ee9492035-SIN
content-length
	450771
content-type
	text/html; charset=UTF-8
date
	Thu, 29 Jan 2026 10:11:23 GMT
expires
	Thu, 01 Jan 1970 00:00:01 GMT
referrer-policy
	same-origin
server
	Vercel
strict-transport-security
	max-age=63072000; includeSubDomains; preload
X-Firefox-Spdy
	h2
x-frame-options
	SAMEORIGIN
x-vercel-cache
	MISS
x-vercel-id
	sin1::x2tw9-1769681464118-35b4ac1c7f0c
	
Accept
	*/*
Accept-Encoding
	gzip, deflate, br, zstd
Accept-Language
	en-US,en;q=0.5
Connection
	keep-alive
Content-Length
	44
Content-Type
	application/json
Cookie
	_csrf=94-ksXAumDBmgkZ52g-J6eUI; x-csrf-token=f79463dac126bc9b51459e32cc5674492863933f4f2d60affa23b53daf404fec.70fddee8e8d8f141d822a68275c61837930afe5dbe0a7ac158bb2e35e7ef5d1e52bc5447e6a38dce4edcbd104474aa6dfaed364046055a1ad992b087f7e36ad4; at=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNta252b3Q5OTAwMDExM3NqajYwczY5cjgiLCJlbWFpbCI6InNha3VyYWFtYWRhNTlAZ21haWwuY29tIiwidXNlcm5hbWUiOiJzYWt1cmEiLCJpYXQiOjE3Njk2ODEyMzQsImV4cCI6MTc2OTY4MjEzNH0.14FIA39P1CS_-of234WetT6f2KXP631RlZ9cs59XkLw; rt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWtudm90OTkwMDAxMTNzamo2MHM2OXI4IiwianRpIjoiYTY5YWEwMzAtMjdkZS00ZjNhLWI0YjAtMjg4NzQwZjMzMGE1IiwiaWF0IjoxNzY5NjgxMjM0LCJleHAiOjE3NzIyNzMyMzR9.C0KdMcFPUB7FY_jxtQBDJVnRi-AHC8LF2-BnhinPdAg
CSRF-Token
	f79463dac126bc9b51459e32cc5674492863933f4f2d60affa23b53daf404fec.70fddee8e8d8f141d822a68275c61837930afe5dbe0a7ac158bb2e35e7ef5d1e52bc5447e6a38dce4edcbd104474aa6dfaed364046055a1ad992b087f7e36ad4
Host
	chat-lite-weld.vercel.app
Origin
	https://chat-lite-weld.vercel.app
Priority
	u=0
Referer
	https://chat-lite-weld.vercel.app/settings
Sec-Fetch-Dest
	empty
Sec-Fetch-Mode
	cors
Sec-Fetch-Site
	same-origin
Sec-GPC
	1
TE
	trailers
User-Agent
	Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0
Uncaught (in promise) SyntaxError: JSON.parse: unexpected character at line 1 column 2 of the JSON data
    G https://chat-lite-weld.vercel.app/assets/SettingsPage-C4QeGn1W.js:23
    M0 https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    Hu https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    zf https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    Hu https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    ec https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:10
    hm https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:10
    k0 https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    ju https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    qu https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    qu https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:9
    createRoot https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:10
    <anonymous> https://chat-lite-weld.vercel.app/assets/index-CKS0FFkj.js:287
SettingsPage-C4QeGn1W.js:23:1309

ValidationError: The Express 'trust proxy' setting is true, which allows anyone to trivially bypass IP-based rate limiting. See https://express-rate-limit.github.io/ERR_ERL_PERMISSIVE_TRUST_PROXY/ for more information.
    at Object.trustProxy (file:///app/node_modules/.pnpm/express-rate-limit@7.5.1_express@4.21.2/node_modules/express-rate-limit/dist/index.mjs:139:13)
    at wrappedValidations.<computed> [as trustProxy] (file:///app/node_modules/.pnpm/express-rate-limit@7.5.1_express@4.21.2/node_modules/express-rate-limit/dist/index.mjs:369:22)
    at Object.keyGenerator (file:///app/node_modules/.pnpm/express-rate-limit@7.5.1_express@4.21.2/node_modules/express-rate-limit/dist/index.mjs:629:20)
    at file:///app/node_modules/.pnpm/express-rate-limit@7.5.1_express@4.21.2/node_modules/express-rate-limit/dist/index.mjs:682:32
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
    at async file:///app/node_modules/.pnpm/express-rate-limit@7.5.1_express@4.21.2/node_modules/express-rate-limit/dist/index.mjs:663:5 {
  code: 'ERR_ERL_PERMISSIVE_TRUST_PROXY',
  help: 'https://express-rate-limit.github.io/ERR_ERL_PERMISSIVE_TRUST_PROXY/'
}