# Dispatch Board

Build a web app with two pages:

1. Login Page

   - Show username and password fields.

   - On submit, fetch JSON from this Google Apps Script Web App URL:

     https://script.google.com/macros/s/AKfycbwa5y_MWiP3CZ566QFFVaLPjcag0Tz37g7xGPEnDOqpeZaFp2JXMp-GbNoF4wXWld3Y/exec

   - The JSON rows are structured as:

     [EngineerID, EngineerName, Username, Password]

   - If credentials match, save EngineerID and EngineerName in localStorage and redirect to Dispatch Page.

   - If credentials fail, show "Invalid login".

2. Dispatch Page

   - On load, read EngineerID from localStorage.

   - Fetch JSON from the same Google Apps Script Web App URL.

   - Filter rows by EngineerID.

   - Display jobs in a table with columns: Job ID, Description, Status.

   - Add a button in each row to update the status.

   - When clicked, send a POST request to the same Google Apps Script Web App URL with parameters:

     row = Job ID

     status = new status value

   - Refresh the table after update.

Style the app with Tailwind CSS for a clean, modern look.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://servicehub52324.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/4ab2ba26-b883-4ba9-b8a3-bbcf155ebd34).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
