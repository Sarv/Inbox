/**
 * Mark Verifying Authority (MVA) root certificates — the trust anchors for
 * BIMI Verified Mark Certificates (VMCs).
 *
 * A VMC is an X.509 certificate that binds a brand's logo to its domain, issued
 * only after the CA has verified the trademark and the domain. It is what
 * earns the blue "verified" tick: a BIMI logo without one is a picture the
 * domain published about itself. VMCs do NOT chain to the web-PKI roots a
 * browser trusts; each MVA runs a dedicated root, so those roots have to be
 * pinned here. Chain validation without a pinned anchor would accept a chain
 * anyone could mint for themselves, which is worse than no tick at all.
 *
 * Every entry records where the certificate came from and its SHA-256
 * fingerprint, so a future reader can re-verify it against the CA's own
 * publication. Roots are long-lived (2040-2049); this list should change only
 * when the BIMI Group admits a new MVA.
 *
 * Retrieved 2026-09-19. Fingerprints checked with:
 *   openssl x509 -in <pem> -noout -fingerprint -sha256
 */

export interface MarkVerifyingAuthorityRoot {
  /** Common name of the root certificate. */
  name: string;
  /** The CA operating it. */
  organization: string;
  /** Where the PEM was fetched from. */
  source: string;
  /** SHA-256 fingerprint of the DER certificate, colon-separated upper-case hex. */
  sha256: string;
  pem: string;
}

export const MVA_ROOTS: readonly MarkVerifyingAuthorityRoot[] = [
  {
    name: 'DigiCert Verified Mark Root CA',
    organization: 'DigiCert, Inc.',
    source: 'https://cacerts.digicert.com/DigiCertVerifiedMarkRootCA.crt.pem',
    sha256: '50:43:86:C9:EE:89:32:FE:CC:95:FA:DE:42:7F:69:C3:E2:53:4B:73:10:48:9E:30:0F:EE:44:8E:33:C4:6B:42',
    pem: `-----BEGIN CERTIFICATE-----
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
0wberd/tg3N0dJsSSznZjwYB
-----END CERTIFICATE-----`,
  },
  {
    name: 'Entrust Verified Mark Root Certification Authority - VMCR1',
    organization: 'Entrust, Inc.',
    source: 'https://crt.sh/?d=4990145127',
    sha256: '78:31:D9:5A:47:D4:25:08:CD:5C:9E:62:64:F9:09:6B:AC:19:F0:4E:B9:B7:C8:BD:D3:5F:FF:C7:1C:18:96:17',
    pem: `-----BEGIN CERTIFICATE-----
MIIFpDCCA4ygAwIBAgIUdDkAvVsH/GPX6RUEUsibtwFoBGMwDQYJKoZIhvcNAQEN
BQAwajELMAkGA1UEBhMCVVMxFjAUBgNVBAoMDUVudHJ1c3QsIEluYy4xQzBBBgNV
BAMMOkVudHJ1c3QgVmVyaWZpZWQgTWFyayBSb290IENlcnRpZmljYXRpb24gQXV0
aG9yaXR5IC0gVk1DUjEwHhcNMjEwNTA3MTMzMTQ4WhcNNDAxMjMwMTMzMTQ4WjBq
MQswCQYDVQQGEwJVUzEWMBQGA1UECgwNRW50cnVzdCwgSW5jLjFDMEEGA1UEAww6
RW50cnVzdCBWZXJpZmllZCBNYXJrIFJvb3QgQ2VydGlmaWNhdGlvbiBBdXRob3Jp
dHkgLSBWTUNSMTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAL1S/GJt
w3EI3J6CcvhFRTpAZUWnTTgj/0n04xEBEZu4bVR8JlYFnadfTm+CLyUkLCU7Ipoq
Y0D6jDcD2skWuXnSsTeQtiFIDiGJH4c6QWmNXw1mZDlNhLse0q2sfXCxlAlfBr9M
c2KOrNUFk36Ld6VQEZOb/R1aU/GwbfN0A/8mDQSRoIHlFgWrtqYwORBF8MFqv4a2
MvE858h6KaKaBy/8TVMuvuYZ32sa1yGHibAP8Kr0YaFHiK+iLJxnJccjyXjzfLMY
zQ9rt/UuAlHTIXsNJE+ZYo4O3unPMK25lHGenEVRWOZiIVm/Kl/JdxqxETZRDwCS
KiXlHcXHkFTtvOQRQ5qcR0p1MrgIUzrzVZSqIM9O92q/tOgsKyv+GoTchBVrn57N
q2EsarFP2zQqLlSC2Z1KTO+c2bjf90BbDL+mlxYycbRfHc5GZ9LXnxmilBSLz5m0
MGq1uamqC5pkri7V2tDe+Mb3FQcD/yDhaTs7jL/ODv1dYv3OCQ9YzUZtgvWSqzi9
rHt2yFotR+XM4BB8n3De1QKnFLZB7s469xRUUjFIJ07lOapBTuZWsarECtAWloW0
uKr0+LLO2nNX3t92qbPcmEu9dI2Z7K94VLZ/ONhVuroPLlzJ36tTP4zLXo5GXaMY
UnosKa2jkMu4QfII9g8NkHYRmUBk26vnCS2JAgMBAAGjQjBAMB0GA1UdDgQWBBRz
I1Z7K3hFgJq4wnzMpYY5iyZ4xTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQE
AwIBhjANBgkqhkiG9w0BAQ0FAAOCAgEASMtZ53rMG+bDGJbYCCucv9KzqgCL166R
V9Eq0zQOXITcfVpJmFeBLq/rMzXCOdWNTdPx6yNdeWk6OW5GullwzJhsutiHcryQ
acDRHEnMf0LodOy2TWLWWonsyctVHa2PtbcViWZ7opctUTmsK6JdMHCAOZHH64Nj
0Vr0VAaLf/A/fF+ZlU1IbcU1Gi/FBJudrT7YD2ISmIukCv7hsdhAtg9TuOVkWKl0
gfDadejTU4l5VlT58ofkxg5aAL2XPJf7ywKzgWlWgLpIZWMsn6+7dOiAq7GqsVKN
zEKTyAc3Hs42hpKtHvZFDGJ3mGVUNPNjEiH7OZ7q1gKB7eysWDcUp+IMLn+nukDo
JUb9H+TiF0i7Zo+roPyzv+fy2tJuioF9NkVGqqOrfTLxOo10gCM42ba4Mf6PkvC4
FkkNb7q7OVi6nsO8pUNJ+PagwFyMLp0vqd4aDTUruey7tKz76SM1D6rN9WJFgZsp
Yj4dKCQPde32Jd9/Sk6G5lHmIbAqqNYLqPRBxByVSBg9+11jMi7e1kIkMQV3wndB
ntRKjHU8Hd0J/UcK8veLaRR2XECTx0I9I31Fis4Q0cSVz+4oXWGBuaREKEut10q2
cAWvd1qUOjLlA4LsxKpVMvc+loyIy5s0+IfcqN4GHYjBKK+m+GWs/u2Q4BiKeVxw
gkWRxBsyYPA=
-----END CERTIFICATE-----`,
  },
  {
    name: 'GlobalSign Verified Mark Root R42',
    organization: 'GlobalSign nv-sa',
    source: 'https://crt.sh/?d=13341357765',
    sha256: 'CD:12:2C:B8:77:C6:92:8B:90:17:B0:F0:B8:0D:BD:50:81:96:30:0B:BD:03:CD:73:56:C3:BE:EF:52:4E:7E:0B',
    pem: `-----BEGIN CERTIFICATE-----
MIIFdDCCA1ygAwIBAgIQf+UwA4GYp199F8APJCyr8zANBgkqhkiG9w0BAQwFADBU
MQswCQYDVQQGEwJCRTEZMBcGA1UEChMQR2xvYmFsU2lnbiBudi1zYTEqMCgGA1UE
AxMhR2xvYmFsU2lnbiBWZXJpZmllZCBNYXJrIFJvb3QgUjQyMB4XDTIzMTExNTAz
NDA1MloXDTQyMTExNTAwMDAwMFowVDELMAkGA1UEBhMCQkUxGTAXBgNVBAoTEEds
b2JhbFNpZ24gbnYtc2ExKjAoBgNVBAMTIUdsb2JhbFNpZ24gVmVyaWZpZWQgTWFy
ayBSb290IFI0MjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANzqTcvu
bRbqX0CzP7sZbHfd1usqWOPrHzoLvbZTnJqt9WgBwQwcGEFl8rmIcOss7XmewAqj
oCx7PQp1FJ+/o/yGezMbnPCglAVwWptUOMIa7UJ/8qrV50/qQSRN8s8MAcnhj3Ab
Ja/mVjlMHzjYCo0O+jc24uHlEHcIo3vJPsP2Sy9HwcMH4wB2rQ4xDN7kAn5NmqXI
xAvSnJ2KGrZsoNx8MGAfX5dl0ACOpaaqbonBGtawvRGAE6f747E+pUamjGjisQ8y
ZC0X5Ht1s53sliy9AHDpOUWVcCLOoQCP/Y8yDjkjE1VWiL1Y7LlCnYfAVfY87DRD
81toIOLjFNACxeG02Qvgzg0JMKh81seiZfSLbq8DgepDABUTs8WYpN/u52/kdM+/
UeaQEn+q2HDDI8OMmBqwVo98k+dCQ0QgKLkHaLxpm5EjacSkNZFeqp1ttDZsGKQt
9REPJxpY6OO9KSYuFNFpnmLfaDNA/VngLw+Z4hYH59RnE2p3s95CfUa+CT4BUvDy
Wefc9RNiJVppbQNiZ4DKKpixVfXptgukbnh5l7vyDVonKGdgNEZeN5YjopM5V2+J
eIrsC3u0OmDV41cSFfe/1dmoUhy5EfTgWXqLOOgoUxqy62Yl7DDwoyXerEzDzZAq
nSBE/HAra3/d5pdj8/5WXoybjbXYM/bsKALLAgMBAAGjQjBAMA4GA1UdDwEB/wQE
AwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBQ9s+P1IK6506ybFLxwJe4P
Cn6VyTANBgkqhkiG9w0BAQwFAAOCAgEA24nHkncSyqeuk1lkpRq/MLVHdVONJnZ6
t8OZEu3nr6DHAuImAonIqO8HcBcgwydDIAeD7GOafOZ47mRkYOFIa+tkJ21pfmJv
KUt3ASW1uLAHCJNYHVLXs7txnq1mRKuwyuaeb6JdTazzjXgNDLZQgvOfM7mkDf6f
S2Z+dbKOZBYwo6zspqoQc1s6k0Xg9h7oEiJCC+3FUfJQSYyi2bynZSEn2c67OSFT
fqXVr9nhlaawLGEKUaFlYeQspUO5MUFYmGWqnf38M8ZM0rPx5R00jZ/E5sKcSqFH
CaVghDPiVv9Jzs8gNllwDbi7rXwMstaKATJJXiWgSdsxrfQr7+FRyXQJmRVXKxZ6
6uNe1ZgAzgNbjCvGmwF1StBtr1DrdOSk7sOMBMuJftB2g9/K67VUfz+jkylIbv5y
bvnCqBoAvq2DSQ76O5WyWiTBkPYp2Fh/WMHkXVIQpT6Q7FMTiGxtAxv69sq1CeJ9
i9g/iAJBdToQwJwH80Ah3hSPg1DQ8LTIjTtOxxkJ6Aeh/XU1/w9lW91XGLgXye1U
fjUIWKsoe1rE2RK+RSP6BZWcRNhJOyqi40gdTRLJkbc0Itq/62NFV4mIWcWKafhb
4ZOU1rvk1woeteJJZHd7cLakW6ONJAEtWGe43ZVx/lqFXQH4kOMPuR/7h2G1Aie6
Fk6hsIjUv20=
-----END CERTIFICATE-----`,
  },
];
