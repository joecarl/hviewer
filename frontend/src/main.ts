import './styles/style.css';
import { appendChild } from 'chispa';
import { App } from './layout/App';
import { routes } from './routes';

appendChild(document.body, App({ routes }));
