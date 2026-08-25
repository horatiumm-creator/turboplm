import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App as AntdApp } from 'antd';
import App from './App';
import { AuthProvider } from './auth/AuthContext';
import { ThemeProvider } from './theme/ThemeContext';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
      ThemeProvider owns the ConfigProvider: the algorithm and the brand token both depend on
      the resolved light/dark mode, so they have to be decided inside something that can react
      to it. Outside AntdApp so that message and modal portals are themed too — they render
      through a context that is captured here.
    */}
    <ThemeProvider>
      <AntdApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntdApp>
    </ThemeProvider>
  </React.StrictMode>
);
