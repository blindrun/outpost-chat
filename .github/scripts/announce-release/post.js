// Posts a release announcement to X (@useoutpost) via the API v2 write
// endpoint. Deliberately a no-op (exit 0, not a failure) when credentials
// aren't configured yet, so this can sit in the release workflow unused
// until the paid API tier is actually set up -- see the desktop.yml comment.
const { TwitterApi } = require('twitter-api-v2');

const {
  TWITTER_API_KEY,
  TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET,
  RELEASE_TAG,
  RELEASE_URL,
  RELEASE_NOTES,
} = process.env;

async function main() {
  if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET) {
    console.log('Twitter API credentials not configured yet -- skipping announcement (not a failure).');
    return;
  }
  if (!RELEASE_TAG || !RELEASE_URL) {
    console.log('RELEASE_TAG or RELEASE_URL missing -- skipping announcement.');
    return;
  }

  const client = new TwitterApi({
    appKey: TWITTER_API_KEY,
    appSecret: TWITTER_API_SECRET,
    accessToken: TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_SECRET,
  });

  const text = composeTweet(RELEASE_TAG, RELEASE_URL, RELEASE_NOTES || '');
  const { data } = await client.v2.tweet(text);
  console.log(`Posted: https://x.com/useoutpost/status/${data.id}`);
}

function composeTweet(tag, url, notes) {
  const header = `Outpost ${tag} is out.`;
  const footer = `\n\n${url}`;
  const budget = 280 - header.length - footer.length - 2; // 2 for the blank line before notes

  let body = '';
  if (notes.trim()) {
    const firstLine = notes.trim().split('\n')[0];
    body = firstLine.length > budget ? firstLine.slice(0, budget - 1) + '…' : firstLine;
  }

  return body ? `${header}\n\n${body}${footer}` : `${header}${footer}`;
}

main().catch((err) => {
  // Log and exit non-zero -- a real failure (bad creds, API error) should be
  // visible in the Actions run, unlike the "not configured yet" case above.
  console.error('Failed to post release announcement:', err.message || err);
  process.exit(1);
});
