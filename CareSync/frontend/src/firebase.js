import { initializeApp } from 'firebase/app';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'REPLACE_WITH_API_KEY',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'caresync-placeholder.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'caresync-placeholder',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'caresync-placeholder.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:placeholder',
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCUcrwBhhnLwl7XBfbfTall8pKoFQdnJXE",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "mkdir200selfe.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "mkdir200selfe",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "mkdir200selfe.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "703652014203",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:703652014203:web:ba26f205cf11f6e7505ade",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-Y3YRCRV6ER",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "https://mkdir200selfe-default-rtdb.firebaseio.com",
};

export const isFirebaseConfigured = Boolean(
  import.meta.env.VITE_FIREBASE_API_KEY &&
    import.meta.env.VITE_FIREBASE_PROJECT_ID &&
    !import.meta.env.VITE_FIREBASE_API_KEY.includes('REPLACE_WITH') &&
    !import.meta.env.VITE_FIREBASE_PROJECT_ID.includes('placeholder')
  firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    !firebaseConfig.apiKey.includes('REPLACE_WITH') &&
    !firebaseConfig.projectId.includes('placeholder')
);

const app = initializeApp(firebaseConfig);
// Initialize Firebase App
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Firebase Firestore (Real-time Document Database used across dashboards)
export const firestoreDb = getFirestore(app);

// Firebase Realtime Database (RTDB)
let rtdb = null;
try {
  rtdb = getDatabase(app);
} catch (err) {
  console.warn("Firebase Realtime Database initialization warning:", err);
}
export const realtimeDb = rtdb;
export const database = rtdb;

export default app;

