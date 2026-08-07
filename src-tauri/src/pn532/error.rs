#[derive(Debug, thiserror::Error)]
pub enum Pn532Error {
    #[error("serial port error: {0}")]
    Serial(#[from] serialport::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid frame: {0}")]
    InvalidFrame(String),
    #[error("not connected to a PN532")]
    NotConnected,
    #[error("no card present")]
    NoCardPresent,
}
