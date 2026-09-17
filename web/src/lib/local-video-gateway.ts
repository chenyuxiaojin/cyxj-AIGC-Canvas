// This fixed local route forwards only to the same configured provider.
export function localVideoGatewayUrl(address: string) {
    try {
        const url = new URL(address);
        if (url.origin === "https://api.laogou.org" && !url.username && !url.password && !url.search && !url.hash
            && (/^\/v1\/(models|chat\/completions|media\/models|media\/videos)$/.test(url.pathname) || /^\/v1\/(?:media\/)?videos\/[A-Za-z0-9_-]+(?:\/content)?$/.test(url.pathname))) {
            return `/api/ai/laogou${url.pathname}`;
        }
    } catch { /* Preserve the original URL so the regular client reports it. */ }
    return address;
}
