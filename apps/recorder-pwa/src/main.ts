import './styles.css';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');
mountApp(root);
