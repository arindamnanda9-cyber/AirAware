const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api'
).replace(/\/+$/, '');

export const CITYWIDE_API_BASE = `${API_BASE_URL}/citywide-expanded`;

export default API_BASE_URL;
