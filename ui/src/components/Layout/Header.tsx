import { NavLink } from 'react-router-dom';
import styles from './Header.module.css';

const navItems = [
  { label: 'Home', to: '/' },
  { label: 'Entities', to: '/entities' },
  { label: 'Links', to: '/links' },
  { label: 'Types', to: '/types' },
  { label: 'Groups', to: '/groups' },
  { label: 'Search', to: '/search' },
];

export function Header() {
  return (
    <header className={styles.header}>
      <div className="container">
        <div className={styles.headerInner}>
          <h1 className={styles.title}>
            <NavLink to="/">Gruff</NavLink>
          </h1>
        </div>
        <nav className={styles.nav}>
          <ul className={styles.navList}>
            {navItems.map(item => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => (isActive ? styles.active : undefined)}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
