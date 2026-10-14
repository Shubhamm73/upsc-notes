/**
 * The owner's Google Cloud project for "Back up to Google Drive" (0.11). These values are public in any
 * web app (there is no client secret): Google only accepts sign-ins that come back to the origins and
 * redirect address set on the OAuth client (https://shubhamm73.github.io, …/upsc-notes/), and the API key
 * should be limited to that site and the Picker API.
 */
export const GOOGLE_CLIENT_ID = '1050877831533-mhmm3iha3kib2kdi7sg9k6o840hpt86d.apps.googleusercontent.com';
/** Only the Google Picker (choose a folder) uses the key. */
export const GOOGLE_API_KEY = 'AIzaSyBvmmQIOOKPx7Hfx6CTM4uw7bjKeWACUs8';
/** Project number: the Picker needs it to give the app access to the folder he picks. */
export const GOOGLE_APP_ID = '1050877831533';

/** "See, edit, create and delete only the specific Google Drive files you use with this app." */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'UPSC Notes backups';
/** Backups kept in the folder; older ones go to his Drive's trash (Google keeps them there 30 days). */
export const KEEP_BACKUPS = 10;
