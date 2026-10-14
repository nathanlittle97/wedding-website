# Nathan & Ashling wedding website

A minimal, password-protected multi-page site with RSVPs, hosted on AWS.

```
site/       Pages (index, schedule, accommodation, faqs, rsvp), styles.css, app.js, config.js, images/
backend/    template.yaml (AWS SAM) and the Lambda API in rsvp/
  rsvp/guests.json    The guest list and which events each guest is invited to
  rsvp/content.json   Home text, events, accommodation info and FAQs
tools/      check_data.py (validate your data), export_rsvps.py (CSV of replies)
```

## How it works

- Guests enter their **first and last name** and the **shared password**. The Lambda API checks the password, then looks the name up in `guests.json` (case, accents, apostrophes and hyphens are ignored, so "o'brien" matches "O'Brien").
- On success the API returns a signed token (valid 14 days). All page content (schedule, accommodation, FAQs, home text, the guest's own events) is fetched from the API with that token, so none of it is in the public files.
- **RSVP:** each guest replies for themselves: email, yes/no for each event they're invited to, dietary requirements, and other notes. A guest replying for a partner uses "RSVP for another guest" at the bottom of the RSVP page, which switches to the partner's name. Replies are stored in DynamoDB, one row per guest, and resending the form updates it.
- The schedule only shows the events the signed-in guest is invited to.

**What is and isn't protected:** the page shells, styles, script and slideshow images are public files on CloudFront, so someone who guesses an image URL can see it. The guest list, event details, accommodation and FAQs are only returned by the API after a correct password. Anyone who knows the shared password and a guest's name can sign in as that guest, which is inherent in a single shared password.

## Edit your data

1. **Guests:** replace the sample entries in `backend/rsvp/guests.json`. Each guest has `firstName`, `lastName` and `events` (ids from `content.json`: `welcome`, `wedding`, `brunch`).
2. **Events, accommodation, FAQs, slides:** edit `backend/rsvp/content.json`. Fill in the empty `date`, `time` and `place` fields (empty ones show "to follow"). Accommodation items look like `{ "name": "...", "note": "...", "phone": "01234 567890", "url": "https://..." }`; `note`, `phone` and `url` are optional.
3. **Photos:** put your images in `site/images/` and list them under `home.slides` in `content.json`. Replace the placeholder SVGs.
4. **Check for mistakes:** `python tools/check_data.py`

Changes to `backend/` need `sam build` and `sam deploy`; changes to `site/` need the upload commands below.

## Preview locally

Pages load content from the API, so a local preview only shows the sign-in screen until you deploy and set `apiUrl` in `site/config.js`.

## Deploy

Install the AWS CLI, AWS SAM CLI and Python 3.12. In PowerShell:

```powershell
cd "D:\Projects\Claude Projects\Wedding Website\backend"
sam build
sam deploy --guided
```

Use stack name `wedding-website` and your nearest region (for example `eu-west-2`). When asked for **SitePassword**, enter the password you want guests to use. Answer **yes** when SAM warns the Function URL has no authorization: the API checks the password itself.

Get the outputs:

```powershell
aws cloudformation describe-stacks --stack-name wedding-website --query "Stacks[0].Outputs" --output table
```

Paste the `ApiUrl` value into `site/config.js`, then upload (use your `BucketName` and `DistributionId`):

```powershell
cd "D:\Projects\Claude Projects\Wedding Website"
aws s3 sync site s3://BUCKET_NAME --delete
aws cloudfront create-invalidation --distribution-id DISTRIBUTION_ID --paths "/*"
```

The site is at the `SiteUrl` output. Repeat the two commands after any edit to `site/`.

## Email notifications

Each RSVP triggers two emails, both best-effort (if one fails, the RSVP is still saved):

- **To you, via SNS:** `NotifyEmail`. After the first deploy AWS emails this address a "Subscription Confirmation" (check spam). Click **Confirm subscription**, otherwise nothing arrives. The message lists the guest's answers, dietary needs, notes, and whether their confirmation email went.
- **To the guest, via SES:** `SenderEmail`. SNS can't do this: it only emails people who have confirmed a subscription to a topic, so SES is used instead. Leave `SenderEmail` empty to turn guest emails off.

**One-off SES setup** (same AWS region as the stack):

1. SES console, then Identities, then Create identity, then Email address. Click the link AWS emails to verify it. Use this address as `SenderEmail`. An address on a domain you own works far better than gmail.com, yahoo.com or outlook.com addresses, which often land in spam or are rejected when sent through SES.
2. New SES accounts are in a **sandbox** and can only email verified addresses. Request production access (SES, then Account dashboard, then Request production access): choose Transactional, give your site address, and say you're sending one RSVP confirmation per guest who typed their own email. Approval usually takes about a day.
3. To test while in the sandbox, verify your own email as a second identity and RSVP with it.

Then `sam deploy --guided` and enter both emails when asked.

Guards: a guest who resubmits within 10 minutes of their last reply gets no second confirmation email (it stops the form being used to send repeated emails to an address). You still get the SNS message. Cost is small: SNS email notifications have a monthly free allowance, and SES is about $0.10 per 1,000 emails. Check current pricing.

## Changing the password

Run `sam deploy` again and enter the new password. Everyone signed in with the old one is signed out. The password is stored as a Lambda environment variable, visible to anyone with access to your AWS account's Lambda console.

## See the RSVPs

`pip install boto3`, then `python tools\export_rsvps.py TABLE_NAME rsvps.csv` (use the `TableName` output). The CSV lists every guest, whether they've replied, their answer for each event, dietary requirements and notes. You can also browse the table in the DynamoDB console.

## Admin dashboard

The small **Admin** link at the bottom of the site opens a dashboard with reply totals, event attendance, guest responses, dietary requirements and notes. It is backed by a separate read-only Lambda API protected by an Amazon Cognito JWT authorizer; it does not use the guest password or the public guest API. The Cognito user pool does not allow public sign-up, so only users you create can sign in. MFA is optional and can be enabled for the user pool.

After deploying the backend:

1. Run `aws cloudformation describe-stacks --stack-name wedding-website --query "Stacks[0].Outputs" --output table` and note `AdminApiUrl`, `AdminAuthUrl`, `AdminClientId` and `AdminUserPoolId`.
2. Paste the first three values into the corresponding `adminApiUrl`, `adminAuthUrl` and `adminClientId` entries in `site/config.js`.
3. Create your administrator account (replace the pool ID and email):

   ```powershell
   aws cognito-idp admin-create-user --user-pool-id USER_POOL_ID --username you@example.com --user-attributes Name=email,Value=you@example.com --desired-delivery-mediums EMAIL
   ```

   Cognito sends an invitation with a temporary password. At first sign-in, choose a permanent password. You can create additional admin accounts using the same command; there is no public sign-up.
4. Upload `site/` and invalidate CloudFront as described above. Then open the small **Admin** link and sign in with that email and password.

The dashboard data includes guest contact details and dietary notes. Keep access to the AWS account and administrator accounts private. The API itself is protected even if someone knows its URL or visits `admin.html` directly.

## Cost and safety

- At wedding-site traffic this should stay within AWS free allowances, but terms vary by account age, so check your Free Tier page. Set a **budget alert** at a few pounds.
- Wrong passwords are slowed down by a one-second delay, but there's no hard lockout. Choose a password that isn't easily guessed.
- `guests.json` holds your guests' names. Keep the project out of any public Git repository.

## Troubleshooting

- **"couldn't reach the server":** open developer tools (F12), then the Network tab. A CORS error means the site address isn't the allowed origin (see the custom domain note in `template.yaml`'s `CustomDomain` parameter). A 403 from the Function URL means its public-invoke permission is missing; redeploying with `sam deploy` normally fixes it.
- **Old content after an update:** run the CloudFront invalidation again.
- **A guest can't sign in:** check how their name is spelled in `guests.json` against what they typed.
