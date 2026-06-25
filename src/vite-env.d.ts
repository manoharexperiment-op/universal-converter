/// <reference types="vite/client" />

// mammoth ships a prebuilt browser bundle without Node's `fs`; it has no types.
declare module 'mammoth/mammoth.browser';
