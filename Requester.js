class Requester {
    constructor(baseUrl, cookies) {
        this.baseUrl = baseUrl;
        this.cookies = cookies;
    }

    async makeRequest(endpoint, message = null) {
        const options = {
            headers: {
                'Cookie': this.cookies.map(c => `${c.name}=${c.value}`).join('; '),
            },
        };

        const request = await fetch(this.baseUrl + endpoint, options);

        if (!request.ok) {
            if (!message) {
                console.error(`Failed to fetch URL: ${this.baseUrl + endpoint} - ${request.status} - ${request.statusText}`);
            } else {
                console.error(`Failed to ${message} - ${request.status} - ${request.statusText}`);
            }
            if (request.status === 401) {
                console.log("Check that you are logged in on Backyard.ai with the specified browser.");
            }
            return null;
        }

        const data = await request.json();

        if (!data || !data[0] || !data[0].result || !data[0].result.data || !data[0].result.data.json) {
            if (!message) {
                console.error("Invalid response structure when fetching URL: ", this.baseUrl + endpoint);
            } else {
                console.error(`Invalid response structure when trying to ${message}`);
            }
            return null;
        }

        return data[0].result.data.json;
    }
}

module.exports = { Requester };