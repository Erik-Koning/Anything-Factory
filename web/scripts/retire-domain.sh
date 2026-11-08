#!/usr/bin/env bash
# Once, for a domain the app has moved off (a6gfactory.dev, for anythingfactory.dev) whose DNS is a Route 53 zone in
# this account:
#   - its web addresses redirect to the same names on the new domain, path and query kept: a certificate for it and
#     *.<old> in us-east-1, where CloudFront takes them from, and retire-domain.yaml, a CloudFormation stack in the
#     app's region (the organization runs CloudFormation nowhere else). A name a stage still serves (dev.<old>, until
#     that stage's npx sst remove) keeps its own records until then, and the wildcard takes it over after;
#   - once no stage serves on it, it sends no mail: the SES identity and the records ses-domain.sh made go, and a null
#     MX, SPF -all and a DMARC reject policy tell receivers so, so nobody can send as it. Until then a stage may still
#     send from it, so this leaves its mail alone and says what's left.
# Safe to run again: run it once more after removing the last stage that served on the old domain.
#
#   AWS_PROFILE=a6g AWS_REGION=us-east-2 web/scripts/retire-domain.sh a6gfactory.dev anythingfactory.dev
#
# Keep the old domain registered while anything may still point at it (a6g 0.6.0's connect app does, by default).
set -euo pipefail

old=${1:?usage: retire-domain.sh <old domain> <new domain>}
new=${2:?usage: retire-domain.sh <old domain> <new domain>}
region=${AWS_REGION:?set AWS_REGION to the region the app runs and sent mail from (us-east-2)}
here=$(cd "$(dirname "$0")" && pwd)
stack="a6g-retired-${old//./-}"

zone=$(aws route53 list-hosted-zones-by-name --dns-name "$old" --max-items 1 \
  --query "HostedZones[?Name=='$old.'].Id | [0]" --output text)
if [ -z "$zone" ] || [ "$zone" = "None" ]; then
  echo "retire-domain: no Route 53 zone for $old in this account" >&2
  exit 1
fi
zone=${zone#/hostedzone/}

cert=$(aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?DomainName=='$old'].CertificateArn | [0]" --output text)
if [ -z "$cert" ] || [ "$cert" = "None" ]; then
  cert=$(aws acm request-certificate --region us-east-1 --domain-name "$old" --subject-alternative-names "*.$old" \
    --validation-method DNS --query CertificateArn --output text)
  echo "retire-domain: asked ACM for a certificate for $old and *.$old"
fi
# Its DNS check (one record serves both names), once ACM has made it up.
for _ in $(seq 30); do
  check=$(aws acm describe-certificate --region us-east-1 --certificate-arn "$cert" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.[Name,Value]' --output text)
  [ -n "$check" ] && [ "$check" != "None" ] && break
  sleep 2
done
read -r check_name check_value <<<"$check"
aws route53 change-resource-record-sets --hosted-zone-id "$zone" --query 'ChangeInfo.Status' --output text --change-batch \
  "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$check_name\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$check_value\"}]}}]}" >/dev/null
aws acm wait certificate-validated --region us-east-1 --certificate-arn "$cert"

aws cloudformation deploy --region "$region" --stack-name "$stack" --template-file "$here/retire-domain.yaml" \
  --parameter-overrides "From=$old" "To=$new" "ZoneId=$zone" "Certificate=$cert" --no-fail-on-empty-changeset
echo "retire-domain: $old and *.$old redirect to $new (stack $stack in $region)"

records=$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" --output json)
# Names a stage still serves: address records besides the stack's own (the apex and the wildcard, which Route 53
# lists as \052).
serving=$(python3 -c '
import json, sys
old = sys.argv[1]
names = {r["Name"] for r in json.loads(sys.argv[2])["ResourceRecordSets"] if r["Type"] in ("A", "AAAA")}
print(" ".join(sorted(n.rstrip(".") for n in names - {old + ".", "\\052." + old + "."})))
' "$old" "$records")
if [ -n "$serving" ]; then
  echo "retire-domain: a stage still serves $serving, and may send mail from $old: remove it (npx sst remove --stage <stage>"
  echo "  from its checkout), then run this again to end $old's mail"
  exit 0
fi

if aws sesv2 get-email-identity --email-identity "$old" --region "$region" >/dev/null 2>&1; then
  aws sesv2 delete-email-identity --email-identity "$old" --region "$region"
  echo "retire-domain: $old is no longer an SES identity in $region"
fi
# What ses-domain.sh made goes (DKIM's CNAMEs, the MAIL FROM's MX and SPF); the apex says it takes and sends no mail,
# keeping any other TXT values it has, and DMARC asks receivers to reject whatever claims to be from it.
batch=$(python3 -c '
import json, sys
old, records = sys.argv[1] + ".", json.loads(sys.argv[2])["ResourceRecordSets"]
changes = []
for r in records:
    values = [v["Value"] for v in r.get("ResourceRecords", [])]
    dkim = r["Type"] == "CNAME" and r["Name"].endswith("._domainkey." + old) and all(v.endswith(".dkim.amazonses.com") for v in values)
    if dkim or (r["Name"] == "mail." + old and r["Type"] in ("MX", "TXT")):
        changes.append({"Action": "DELETE", "ResourceRecordSet": r})
def upsert(name, kind, values):
    return {"Action": "UPSERT", "ResourceRecordSet": {"Name": name, "Type": kind, "TTL": 3600, "ResourceRecords": [{"Value": v} for v in values]}}
txt = next((r for r in records if r["Name"] == old and r["Type"] == "TXT"), None)
kept = [v["Value"] for v in (txt or {}).get("ResourceRecords", []) if not v["Value"].startswith("\"v=spf1")]
changes.append(upsert(old, "MX", ["0 ."]))
changes.append(upsert(old, "TXT", kept + ["\"v=spf1 -all\""]))
changes.append(upsert("_dmarc." + old, "TXT", ["\"v=DMARC1; p=reject; adkim=s; aspf=s\""]))
print(json.dumps({"Comment": "No mail from " + old.rstrip("."), "Changes": changes}))
' "$old" "$records")
aws route53 change-resource-record-sets --hosted-zone-id "$zone" --change-batch "$batch" --query 'ChangeInfo.Status' --output text >/dev/null
echo "retire-domain: $old sends no mail (null MX, SPF -all, DMARC reject; DKIM and MAIL FROM records removed)"
