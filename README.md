# BackyardAIOnlineByafExport

This tool allows you to export your online characters from [Backyard.ai](https://backyard.ai) (BYAF extension).  
<br>

You are welcome to propose ideas in the **Issues** section or submit **Pull Requests**.  
<br>

> [!IMPORTANT]
> The "Parties" feature from Backyard.ai is **not supported**. Characters belonging to parties will simply be separated from the party.  
I currently don’t plan to support this feature, but you are still welcome to open a Pull Request if you wish to implement it.

<br>

# Requirements

- You must have [NodeJS](https://nodejs.org/en) installed in your environment
- Clone the repo using the command `git clone https://github.com/Lufou/BackyardAIOnlineByafExport.git`
- Go to the folder of the repo you've just cloned (with the `cd` command)
- Here, execute the command `npm install` to install required dependencies.
<br>

# How to run it ?

Very easy, just go to the folder you've cloned the repo into and execute the command `node .`
<br>

## FAQ

### Q: Why does the tool need my cookies?
**A:** In order to access your online character list and data, you must be logged in to Backyard.ai.  
The tool uses your cookies to authenticate with Backyard.ai and export your characters.  
<br>

### Q: How does the tool use my cookies?
**A:** You can check how it works in the file `cookies_extractor.js`.  
It accesses your browser profile folder, reads the database containing your saved cookies, and then uses `main.js` to extract only the cookies for the **backyard.ai** domain — nothing else.  

The cookies are **not modified**, **not sent anywhere**, and are only used for authenticated requests to the Backyard.ai website.  
<br>

### Q: Do you plan on adding feature X?
**A:** Planned features are listed in the `TODO` file.  
If you have an idea, please open an **Issue**.  
You’re also very welcome to submit **Pull Requests** to suggest or add new features.  
