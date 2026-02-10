import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <p>Gruff v1.0.0 - Entity-Relationship Database with Versioning</p>
        <p>
          <a href="/docs">API Documentation</a> | <a href="/health">Health Check</a> |{' '}
          <a href="/api/version">Version Info</a>
        </p>
      </div>
    </footer>
  );
}
