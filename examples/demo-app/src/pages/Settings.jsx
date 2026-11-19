import Card from '../components/Card.jsx';

export default function Settings() {
  return (
    <section className="container section narrow">
      <div className="page-head">
        <h1>Settings</h1>
        <p className="muted">Manage your profile and how Tidepool reaches you.</p>
      </div>
      <Card title="Profile">
        <form className="form" onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            <span>Name</span>
            <input defaultValue="Sam Rivera" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" defaultValue="sam@example.com" />
          </label>
          <label className="field">
            <span>Home station</span>
            <select defaultValue="kelp">
              <option value="north">North Pier</option>
              <option value="harbor">Harbor Mouth</option>
              <option value="kelp">Kelp Point</option>
            </select>
          </label>
          <div className="form-actions">
            <button className="button" type="submit">Save changes</button>
          </div>
        </form>
      </Card>
      <Card title="Notifications">
        <label className="toggle">
          <input type="checkbox" defaultChecked />
          <span>Email me when a sensor crosses its threshold</span>
        </label>
        <label className="toggle">
          <input type="checkbox" />
          <span>Send a weekly summary</span>
        </label>
      </Card>
      <Card title="Danger zone">
        <p className="muted">Deleting your workspace removes all sensors and history. This can't be undone.</p>
        <button className="button button-danger">Delete workspace</button>
      </Card>
    </section>
  );
}
