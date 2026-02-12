export const metadata = {
  title: 'Tweet Watcher Dashboard',
  description: 'Configure your tweet monitoring',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ 
        margin: 0, 
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: '#0a0a0a',
        color: '#ededed',
        minHeight: '100vh'
      }}>
        {children}
      </body>
    </html>
  );
}
